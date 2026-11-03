/**
 * 豆包语音合成（V3 HTTP 单向流式）：一次请求拿回整句 mp3。
 * 按音色选资源和鉴权：
 *   - 复刻音色（S_ 开头）：seed-icl-2.0，新版控制台的 API Key（X-Api-Key）；固定按中文念（复刻时用的参考音频可能是别的语言）
 *   - 2.0 音色（…_uranus_bigtts）：seed-tts-2.0，新版控制台的 API Key
 *   - 其余（1.0 音色）：seed-tts-1.0，旧版控制台的 APP ID + Access Token
 * 密钥不进配置：通过 DSH 的 credentials 服务按名字取（DOUBAO_TTS_API_KEY / DOUBAO_TTS_APP_ID / DOUBAO_TTS_ACCESS_KEY）。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VOICE, usesNewConsole } from './voices';

export { DEFAULT_VOICE };
export const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export interface TtsAuth {
  /** 旧版控制台（1.0 音色） */
  appId?: string;
  accessKey?: string;
  /** 新版控制台（2.0 音色、复刻音色） */
  apiKey?: string;
  /** 本地 GPT-SoVITS（自训音色）：api_v2.py 的地址与参考音频 */
  local?: LocalTts;
}

/** 本地 GPT-SoVITS 服务（api_v2.py）：一个地址 + 一句参考音频 */
export interface LocalTts {
  url: string;
  refAudio: string;
  promptText: string;
  /** 语速倍率，1 是原速 */
  speed?: number;
}

interface VoiceRoute {
  resource: string;
  /** 新版控制台的 API Key 还是旧版的 APP ID + Access Token */
  newConsole: boolean;
  additions?: Record<string, unknown>;
}

/**
 * 复刻音色要说清楚念哪种语言（不说的话中文会念成别的腔调，见 hiyoriai 的实测）。
 * 每段单独合成，所以按这一段的字来定：假名占一半以上就是日语，别的按中文（中文里夹几个日语词也按中文，那几个词照样念得出来）
 */
export function languageOf(text: string): 'ja' | 'zh-cn' {
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const letters = (text.match(/[\u3040-\u30ff\u4e00-\u9fffA-Za-z]/g) ?? []).length;
  return kana >= 2 && kana * 2 >= letters ? 'ja' : 'zh-cn';
}

export function routeOf(voice: string, text = ''): VoiceRoute {
  if (voice.startsWith('S_')) return { resource: 'seed-icl-2.0', newConsole: true, additions: { explicit_language: languageOf(text) } };
  if (usesNewConsole(voice)) return { resource: 'seed-tts-2.0', newConsole: true };
  return { resource: 'seed-tts-1.0', newConsole: false };
}

/** 这个音色要的密钥配齐了没有 */
export function canSpeak(auth: TtsAuth, voice: string): boolean {
  if (auth.local) return !!auth.local.url;
  return routeOf(voice).newConsole ? !!auth.apiKey : !!(auth.appId && auth.accessKey);
}

/** 逐字时间：这个字（可能带着后面的标点）在音频里从几秒念到几秒 */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface Speech {
  audio: Uint8Array;
  /** 开了 enable_subtitle 才有；按音频里的先后排好 */
  words: TimedWord[];
}

/** rate：语速（-50 到 100，0 是正常） */
export async function synthesize(auth: TtsAuth, voice: string, text: string, signal: AbortSignal, rate = 0): Promise<Speech> {
  if (auth.local) return localSynthesize(auth.local, text, signal, rate);
  const route = routeOf(voice, text);
  const keyHeaders: Record<string, string> = route.newConsole
    ? { 'X-Api-Key': auth.apiKey ?? '' }
    : { 'X-Api-App-Id': auth.appId ?? '', 'X-Api-Access-Key': auth.accessKey ?? '' };
  const res = await fetch(TTS_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...keyHeaders,
      'X-Api-Resource-Id': route.resource,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'dsh-livestreamingcompanion' },
      req_params: {
        text,
        speaker: voice,
        // enable_subtitle：每句念完后带回逐字时间（音频里的绝对秒数），字幕按它走，不按字数估
        audio_params: { format: 'mp3', sample_rate: 24000, enable_subtitle: true, ...(rate ? { speech_rate: rate } : {}) },
        ...(route.additions ? { additions: JSON.stringify(route.additions) } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`豆包语音 HTTP ${res.status}（${route.resource}）`);
  const chunks: Buffer[] = [];
  const words: TimedWord[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    let msg: {
      code?: number; message?: string; data?: string;
      sentence?: { words?: Array<{ word?: string; startTime?: number; endTime?: number }> };
    };
    // 上游偶尔夹一行非 JSON（风控页、SSE 前缀、被截断的行）：跳过它，别让整句合成失败
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      continue;
    }
    if (msg.data) chunks.push(Buffer.from(msg.data, 'base64'));
    // 第一条 sentence 是整段文字（words 为空），后面每句一条带逐字时间
    else if (msg.sentence?.words?.length) {
      for (const w of msg.sentence.words) {
        if (w.word && typeof w.startTime === 'number' && typeof w.endTime === 'number') words.push({ word: w.word, start: w.startTime, end: w.endTime });
      }
    } else if (msg.code && msg.code !== 20000000) throw new Error(`豆包语音 ${msg.code} ${msg.message ?? ''}`);
  }
  words.sort((a, b) => a.start - b.start);
  return { audio: new Uint8Array(Buffer.concat(chunks)), words };
}

/**
 * 逐字时间 → 字幕时间线：每个字开始念时亮到它前面，念完时亮到它（连同带着的标点）。
 * 按顺序在原文里找每个字，对不上的跳过（服务端偶尔改写个别字）；返回 [亮到第几个字, 音频里的毫秒]
 */
export function subtitleTimeline(text: string, words: TimedWord[]): Array<{ chars: number; atMs: number }> {
  const chars = [...text];
  const points: Array<{ chars: number; atMs: number }> = [];
  let cursor = 0;
  for (const w of words) {
    const piece = [...w.word];
    // 只用第一个字定位（后面可能粘着标点），在接下来几个字里找
    let found = -1;
    for (let i = cursor; i < Math.min(chars.length, cursor + 8); i++) {
      if (chars[i] === piece[0]) { found = i; break; }
    }
    if (found < 0) continue;
    points.push({ chars: found, atMs: Math.round(w.start * 1000) });
    cursor = Math.min(chars.length, found + piece.length);
    points.push({ chars: cursor, atMs: Math.round(w.end * 1000) });
  }
  return points;
}

/** 没有音频时按字数估朗读时长 */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, text.length * 230);
}
/**
 * 本地 GPT-SoVITS（api_v2.py）合成一句：返回 32 kHz wav 字节。
 * 它不给词级时间戳，words 留空 —— 舞台那边会按音频时长把字幕均匀铺开（store.ts 的 litChars 兜底）。
 */
async function localSynthesize(local: LocalTts, text: string, signal: AbortSignal, rate: number): Promise<Speech> {
  const url = local.url.replace(/\/$/, '');
  const res = await fetch(`${url}/tts`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      text_lang: 'zh',
      ref_audio_path: local.refAudio,
      prompt_text: local.promptText,
      prompt_lang: 'zh',
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false,
      top_k: 15,
      top_p: 1,
      temperature: 1,
      speed_factor: local.speed ?? (rate ? 1 + rate / 100 : 1),
      seed: 42,
    }),
  });
  if (!res.ok) throw new Error(`本地语音 HTTP ${res.status}（${url}）`);
  const wav = Buffer.from(await res.arrayBuffer());
  if (wav.length < 100) throw new Error('本地语音没返回音频');
  // wav 一句 500+ KB，走 SSE 传舞台太沉；转 96 kbps mp3（和豆包一个量级）。转不了就用原 wav，舞台按魔数自己选 mime
  const mp3 = await toMp3(wav, signal);
  return { audio: new Uint8Array(mp3 ?? wav), words: [] };
}

/** ffmpeg 路径：环境变量 → PATH → WinGet 常见位置 */
function ffmpegPath(): string | null {
  if (process.env.DSH_LIVESTREAM_FFMPEG) return process.env.DSH_LIVESTREAM_FFMPEG;
  const fromPath = (process.env.PATH ?? '').split(';').map((p) => join(p, 'ffmpeg.exe')).find((p) => existsSync(p));
  if (fromPath) return fromPath;
  const guesses = [
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  return guesses.find((p) => existsSync(p)) ?? null;
}

/** wav → mp3（96 kbps）；任何一步失败返回 null，让调用方用原 wav */
const TO_MP3_TIMEOUT_MS = 10_000;

export async function toMp3(wav: Buffer, signal?: AbortSignal): Promise<Buffer | null> {
  const exe = ffmpegPath();
  if (!exe) return null;
  return new Promise((resolve) => {
    const child = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'mp3', '-codec:a', 'libmp3lame', '-b:a', '96k', 'pipe:1'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    // kill 一个没起来或已经退出的进程会抛 EINVAL；这里只是收尾，不该反过来把调用方炸掉
    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        /* 进程已经没了 */
      }
    };
    // 只收尾一次：error / close / abort / 超时可能先后都到
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      killChild();
      finish(null);
    };
    // 先把所有监听挂好，再碰 signal / timer —— 否则 abort 里的同步异常会让后面的监听全丢掉
    child.stdout!.on('data', (c: Buffer) => chunks.push(c));
    child.stdout!.on('error', () => finish(null));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    // ffmpeg 提前退出时写 stdin 会 EPIPE；Writable 没有 error 监听就是未捕获异常，会崩掉整个宿主进程
    child.stdin!.on('error', () => finish(null));
    // ffmpeg 卡死时 close 永不触发，这里兜一个上限，免得本地合成跟着永久挂起
    timer = setTimeout(() => {
      killChild();
      finish(null);
    }, TO_MP3_TIMEOUT_MS);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    child.stdin!.end(wav);
  });
}
