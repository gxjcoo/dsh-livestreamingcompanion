/**
 * 舞台服务器：插件自己开一个端口（DSH 网页版和桌面版都能用），OBS 的浏览器源直接打开它。
 *
 *   GET  /?token=…                 舞台页（按当前模板摆好挂件）
 *   GET  /stage.js /stage.css       舞台页的代码（插件包 lib/）
 *   GET  /characters/<id>/<file>   角色包、/templates/<id>/<file> 模板（见 packs.ts）
 *   GET  /events?token=…           舞台事件流（SSE）
 *   POST /said?id=…&token=…        舞台念完一句
 *   GET  /video?id=…&token=…       正在放的视频（转发 B 站 CDN，带它要的 Referer，支持 Range）
 *   POST /media?id=…&state=…&token=…  视频开始放、放完、放不出来
 *
 * 所有请求都要带 token（OBS 里填的地址自带），只监听本机。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { StageEvent } from '../stage/protocol';
import type { Packs } from './packs';
import type { Stage } from './stage';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

export interface StageServerOptions {
  port: number;
  token: string;
  /** 插件包目录（有 lib/、stage/） */
  packageDir: string;
  packs: Packs;
  stage: Stage;
  /** 浏览器采集页（/capture）送来的 WebM 分片：写进多平台推流的 ffmpeg */
  feed?: (chunk: Uint8Array) => boolean;
  /** 现在用哪个角色、哪个模板 */
  current(): { character: string; template: string };
  /** 舞台上放的视频：id → CDN 地址；舞台的回执 */
  media?: {
    source(id: string): string | null;
    report(id: string, state: 'playing' | 'ended' | 'error', positionSec?: number, detail?: string): void;
  };
  log?(level: 'info' | 'warn', message: string): void;
}

export class StageServer {
  private server: Server | null = null;

  /** 舞台页代码的版本：lib/stage.js 的修改时间。插件更新、DSH 重启后变，开着的舞台页（OBS）看到就自己刷新 */
  private readonly build: string;

  constructor(private readonly options: StageServerOptions) {
    const script = join(options.packageDir, 'lib', 'stage.js');
    this.build = existsSync(script) ? String(Math.round(statSync(script).mtimeMs)) : '';
  }

  get url(): string {
    return `http://127.0.0.1:${this.options.port}/?token=${this.options.token}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.options.log?.('warn', `舞台请求出错：${(err as Error).message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.requestTimeout = 0;
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject);
        // listen 之后原来的 reject 监听被摘掉了：不补一个持久的，运行期 socket 错误会变成未捕获异常
        server.on('error', (err: Error) => this.options.log?.('warn', `舞台服务器出错：${err.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  // ── 请求 ────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== this.options.token) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('舞台地址不对：请从 DSH 的直播控制台复制完整地址（带 token）。');
      return;
    }
    const path = url.pathname;
    if (req.method === 'POST' && path === '/said') {
      this.options.stage.said(url.searchParams.get('id') ?? '');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/media') {
      const state = url.searchParams.get('state');
      if (state === 'playing' || state === 'ended' || state === 'error') {
        if (state === 'error') this.options.log?.('warn', `舞台放视频出错：${(url.searchParams.get('detail') ?? '').slice(0, 200)}`);
        this.options.media?.report(url.searchParams.get('id') ?? '', state, Number(url.searchParams.get('at') ?? NaN), url.searchParams.get('detail') ?? undefined);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/capture') {
      // 浏览器采集页把 MediaRecorder 的分片 POST 过来，直接喂给多平台推流的 ffmpeg
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        req.on('data', (b: Buffer) => chunks.push(b));
        req.on('end', () => resolve());
        req.on('error', () => resolve());
      });
      const body = Buffer.concat(chunks);
      const ok = body.length ? (this.options.feed?.(new Uint8Array(body)) ?? false) : false;
      res.writeHead(ok ? 204 : 409);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (path === '/events') return this.events(req, res, url);
    if (path === '/video') return this.video(req, res, url.searchParams.get('id') ?? '');
    if (path === '/' || path === '/index.html') return this.file(res, join(this.options.packageDir, 'stage', 'index.html'));
    if (path === '/capture' || path === '/capture.html') return this.file(res, join(this.options.packageDir, 'stage', 'capture.html'));
    if (path === '/stage.js') return this.file(res, join(this.options.packageDir, 'lib', 'stage.js'));
    if (path === '/stage.css') return this.file(res, join(this.options.packageDir, 'stage', 'stage.css'));
    const pack = /^\/(characters|templates)\/([\w-]{1,64})\/(.+)$/.exec(path);
    if (pack) {
      const dir = this.options.packs.dir(pack[1] as 'characters' | 'templates', pack[2]);
      if (dir) return this.file(res, join(dir, decodeURIComponent(pack[3])), dir);
    }
    res.writeHead(404);
    res.end();
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: StageEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const { character, template } = this.options.current();
    const c = this.options.packs.character(character);
    // ?template=<id>：给控制台的「换主题预览」和缩略图截图用，只影响这一条事件流，不碰真实设置
    const forced = url.searchParams.get('template');
    const forcedTemplate = forced && /^[\w-]{1,64}$/.test(forced) ? this.options.packs.template(forced) : null;
    const t = forcedTemplate ?? this.options.packs.template(template);
    if (c && t) send({ v: 1, type: 'hello', character: c, template: t, build: this.build, at: Date.now() });
    // ?preview=1：控制台里的预览，静音、不回执
    const unsubscribe = this.options.stage.subscribe(send, url.searchParams.get('preview') !== '1');
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  /** 转发视频：B 站 CDN 要 Referer；浏览器拖进度、OBS 边下边放都靠 Range */
  private async video(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const source = this.options.media?.source(id);
    if (!source) {
      res.writeHead(404);
      res.end();
      return;
    }
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    let upstream: Response;
    try {
      upstream = await fetch(source, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          // 谁的 CDN 就用谁的 Referer：B 站和抖音都会拦跨站取流
          Referer: /douyin|douyinvod|bytecdn|zjcdn|bytedance/i.test(source) ? 'https://www.douyin.com/' : 'https://www.bilibili.com/',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        signal: abort.signal,
      });
    } catch (err) {
      if (!abort.signal.aborted) this.options.log?.('warn', `视频取不到：${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
      return;
    }
    const type = upstream.headers.get('content-type') ?? '';
    // 上游给了 HTML/JSON（403 页、风控页）时别往 <video> 里灌：那会变成 MediaError 2，
    // 舞台只会说「放不出来」，看不到真正的原因。这里明确失败并记一条。
    if (!upstream.ok || (type && !/^video\/|^application\/octet-stream/i.test(type))) {
      void upstream.body?.cancel();
      let host = source;
      try {
        host = new URL(source).host;
      } catch {
        /* 不是 URL */
      }
      if (!abort.signal.aborted) this.options.log?.('warn', `视频源不可用：HTTP ${upstream.status} ${type || '(no type)'} @ ${host}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
      return;
    }
    const headers: Record<string, string> = { 'content-type': type || 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  }

  private file(res: ServerResponse, file: string, within?: string): void {
    const resolved = normalize(file);
    // 只给包里或用户目录里的文件（防 ../ 跳出去）
    if (within && !resolved.startsWith(normalize(within) + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      // 缩略图会被重新生成：缓存一小时会让控制台一直看到旧图，所以 preview.* 不缓存
      'cache-control': extname(resolved) === '.html' || extname(resolved) === '.js' || /^preview\./i.test(basename(resolved))
        ? 'no-store'
        : 'max-age=3600',
    });
    res.end(readFileSync(resolved));
  }
}
