/**
 * 主人控制台：连直播间、开播下播、OBS 地址、换模板和角色、舞台预览、看弹幕、跟她说话、模拟观众。
 *
 * 开播 = 开一个「大肥鱼直播」会话 + 身体开播（/onair，带上这个会话）。之后往会话里推事情的是身体（宿主端），
 * 这一页关掉也不影响直播。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';

// ── DSH 服务 ──────────────────────────────────────────

interface RemoteResult { ok: boolean; error?: { message: string } }

export interface ConsoleServices {
  workspaces: { list: { getSnapshot(): { items: readonly { workspaceId: string }[] } } };
  uiWorkspace: { openSession(sessionId: string): void };
  sessions: {
    create(opts: { workspaceId: string }): Promise<string>;
    using<T>(target: string, options: { source: string }, operation: (reference: { ready: Promise<{ session: any }> }) => T | Promise<T>): Promise<T>;
  };
  remote: { agentPresets: { select(sessionId: string, presetId: string): Promise<RemoteResult> } };
  layout: { selectPanel(panelId: string | null): void };
}

export interface Credentials {
  describe(refs: string[]): Promise<{ ok: boolean; value?: Record<string, { configured?: boolean } | undefined> }>;
  set(ref: string, value: string): Promise<unknown>;
}

let services: ConsoleServices | null = null;
let credentials: Credentials | null = null;
const serviceListeners = new Set<() => void>();
let serviceVersion = 0;

export function bindConsole(next: ConsoleServices): void {
  services = next;
  serviceVersion += 1;
  for (const l of serviceListeners) l();
}

export function bindCredentials(next: Credentials | null): void {
  credentials = next;
  serviceVersion += 1;
  for (const l of serviceListeners) l();
}

function useCredentials(): Credentials | null {
  useSyncExternalStore((l) => { serviceListeners.add(l); return () => serviceListeners.delete(l); }, () => serviceVersion);
  return credentials;
}

function useServices(): ConsoleServices | null {
  useSyncExternalStore((l) => { serviceListeners.add(l); return () => serviceListeners.delete(l); }, () => serviceVersion);
  return services;
}

// ── 宿主接口 ──────────────────────────────────────────

const PRESET_ID = 'dsh-livestreamingcompanion';
/** 游戏线（另一个会话里的她，专门玩游戏）用的预设 */
const GAME_PRESET_ID = 'dsh-livestreamingcompanion-game';
const SECRET_REFS = { cookie: 'BILIBILI_COOKIE', douyin: 'DOUYIN_COOKIE', tts: 'DOUBAO_TTS_API_KEY' } as const;

/** 平台在界面上怎么称呼 */
const PLATFORMS = [
  { id: 'bilibili', name: 'B 站', roomHint: '直播间网址最后那串数字' },
  { id: 'douyin', name: '抖音', roomHint: 'live.douyin.com 后面那串数字' },
] as const;

function platformName(id: string | undefined): string {
  return id === 'douyin' ? '抖音' : 'B 站';
}

interface PackEntry { id: string; name: string; builtin: boolean; stamp?: string }
interface SpokenLine { text: string; mood: string; at: number }
interface ShowStatus {
  live: { state: string; room?: { platform?: string; title?: string; anchorName?: string; realRoomId?: number }; loggedIn: boolean; stats: { online?: number; live?: boolean }; perMinute: Record<string, number>; lastError?: string };
  onAir: boolean;
  brain: 'off' | 'listening' | 'thinking' | 'speaking' | 'away';
  brainSession: string | null;
  heat: string;
  audience: boolean;
  pending: Record<string, number>;
  lines: SpokenLine[];
  stageWatchers: number;
  roomId: number | null;
}
interface BroadcastStatus {
  phase: 'idle' | 'preparing' | 'face' | 'streaming' | 'stopping' | 'error';
  step: string;
  roomId: number | null;
  faceQr: string | null;
  error: string | null;
  health: { active: boolean; timecode: string; skipped: number; total: number; renderSkipped: number; outputSkipped: number; kbps: number } | null;
  startedAt: number | null;
}
interface HostState {
  ok: boolean;
  show: ShowStatus;
  broadcast: BroadcastStatus;
  settings: {
    platform?: 'bilibili' | 'douyin';
    roomId: number | null;
    douyinRoom?: number | null;
    douyinBrowser?: string;
    douyinAlsoListen?: boolean;
    character: string; template: string; showTerminal?: boolean; voice: string; stagePort: number; idleAfterSec: number; gameChatGapSec?: number;
    distillModel: string; ownRooms: number[]; ownDouyinRooms?: number[]; broadcast: boolean; areaId: number | null; liveTitle: string;
    pushProtocol: 'srt' | 'rtmp'; streamKbps: number; manualPushAddr?: string; manualPushCode?: string; asrPython: string; asrModel: string;
    ttsBackend?: 'doubao' | 'gptsovits'; gptsovitsUrl?: string; gptsovitsRef?: string; gptsovitsPrompt?: string;
    boardText: string; noticeText?: string;
    pace?: { welcomeSec?: number | 'off'; thanksSec?: number; followSec?: number; chatPicks?: number };
  };
  stageUrl: string;
  stageLanUrl?: string | null;
  characters: PackEntry[];
  templates: PackEntry[];
  asr: { available: boolean };
  defaultBoard: string;
}

async function api<T = HostState>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/dsh-livestreamingcompanion/${path}`, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ── 事件流 ────────────────────────────────────────────

interface FeedRow { key: string; kind: string; uid: string; name: string; text: string; yuan?: number; at: number }

interface Live {
  status: ShowStatus | null;
  broadcast: BroadcastStatus | null;
  feed: FeedRow[];
  focus: Set<string>;
  brainDetail: string;
}

let live: Live = { status: null, broadcast: null, feed: [], focus: new Set(), brainDetail: '' };
const liveListeners = new Set<() => void>();
let source: EventSource | null = null;
let feedSeq = 0;

function setLive(change: (l: Live) => Live): void {
  live = change(live);
  for (const l of liveListeners) l();
}

function connectFeed(): void {
  if (source) return;
  source = new EventSource('/api/dsh-livestreamingcompanion/events');
  source.addEventListener('status', (m) => setLive((l) => ({ ...l, status: JSON.parse((m as MessageEvent).data) as ShowStatus })));
  source.addEventListener('broadcast', (m) => setLive((l) => ({ ...l, broadcast: JSON.parse((m as MessageEvent).data) as BroadcastStatus })));
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'live') {
      const ev = e.event;
      if (e.isUpdate && ev.kind !== 'gift') return;
      const text = ev.kind === 'chat' || ev.kind === 'superchat' ? ev.text
        : ev.kind === 'gift' ? `送出 ${ev.gift} ×${ev.count}`
          : ev.kind === 'membership' ? `开通了${ev.level}`
            : ev.kind === 'enter' ? '进入直播间' : '关注了直播间';
      setLive((l) => {
        const existing = l.feed.findIndex((r) => r.key === ev.id);
        const row: FeedRow = { key: ev.id, kind: ev.kind, uid: ev.user.id, name: ev.user.name, text, yuan: ev.yuan, at: Date.now() };
        const feed = existing >= 0 ? l.feed.map((r, i) => (i === existing ? row : r)) : [...l.feed, row].slice(-200);
        return { ...l, feed };
      });
    } else if (e.type === 'say') {
      setLive((l) => ({ ...l, feed: [...l.feed, { key: `say-${++feedSeq}`, kind: 'her', uid: '', name: '她', text: e.text, at: Date.now() }].slice(-200) }));
    } else if (e.type === 'focus') {
      setLive((l) => ({ ...l, focus: new Set(e.userIds) }));
    } else if (e.type === 'brain') {
      setLive((l) => ({ ...l, brainDetail: e.detail ?? '' }));
    }
  };
}

function useLive(): Live {
  useEffect(connectFeed, []);
  return useSyncExternalStore((l) => { liveListeners.add(l); return () => liveListeners.delete(l); }, () => live);
}

// ── 开播：会话 ────────────────────────────────────────

/** 开一个用「大肥鱼直播」预设的会话（她直播用） */
async function createBrainSession(svc: ConsoleServices, line: 'live' | 'game' = 'live'): Promise<string> {
  const workspace = svc.workspaces.list.getSnapshot().items[0];
  if (!workspace) throw new Error('先在 DSH 里打开一个工作区。');
  const sessionId = await svc.sessions.create({ workspaceId: workspace.workspaceId });
  const selected = await svc.remote.agentPresets.select(sessionId, line === 'game' ? GAME_PRESET_ID : PRESET_ID);
  if (!selected.ok) throw new Error(selected.error?.message ?? `没能用上「${line === 'game' ? '大肥鱼直播·游戏线' : '大肥鱼直播'}」预设。`);
  // 让会话就绪（agent 起来），身体才能往里推
  // 会话列表里一眼认得出是哪一场（不然叫「未命名」）
  const d = new Date();
  const title = `直播${line === 'game' ? '游戏线' : ''} · ${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  await svc.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
    const { session } = await reference.ready;
    await session.rename?.(title)?.catch?.(() => {});
  });
  return sessionId;
}

async function cancel(svc: ConsoleServices, sessionId: string): Promise<void> {
  await svc.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
    const { session } = await reference.ready;
    await session.cancel();
  });
}

// ── 小组件 ────────────────────────────────────────────

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  return <i className={`dl-dot dl-${tone}`} />;
}

const BRAIN_TEXT = { off: '没在播', listening: '在听弹幕', thinking: '正在想', speaking: '在说话', away: '暂时走开了' } as const;
const CONN_TEXT: Record<string, string> = { idle: '没连接', connecting: '连接中', connected: '已连上', reconnecting: '重连中', error: '连接出错' };

function useBusy(): [boolean, string, (run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    fn().catch((e) => setError((e as Error).message)).finally(() => setBusy(false));
  };
  return [busy, error, run];
}

/** 两个密钥配好没有（开播前准备清单和设置里都用）；保存后 bump 一下大家重新问 */
let secretVersion = 0;
const secretListeners = new Set<() => void>();
function bumpSecrets(): void {
  secretVersion += 1;
  for (const l of secretListeners) l();
}

function useSecrets(): Record<string, boolean | null> {
  const creds = useCredentials();
  const version = useSyncExternalStore((l) => { secretListeners.add(l); return () => secretListeners.delete(l); }, () => secretVersion);
  const [state, setState] = useState<Record<string, boolean | null>>({ cookie: null, douyin: null, tts: null });
  useEffect(() => {
    if (!creds) return;
    const refs = [SECRET_REFS.cookie, SECRET_REFS.douyin, SECRET_REFS.tts];
    void creds
      .describe(refs)
      .then((r) => setState({
        cookie: !!r.value?.[SECRET_REFS.cookie]?.configured,
        douyin: !!r.value?.[SECRET_REFS.douyin]?.configured,
        tts: !!r.value?.[SECRET_REFS.tts]?.configured,
      }))
      .catch(() => {});
  }, [creds, version]);
  return state;
}

/** 抖音登录：弹一个看得见的 Chrome，扫码登完把整条 Cookie 存进 DSH 凭据（抖音搜索只对登录用户开放） */
function DouyinLogin({ configured }: { configured: boolean | null }) {
  const [busy, error, run] = useBusy();
  const [note, setNote] = useState('');
  type CheckReply = { ok: boolean; error?: string; check?: { api: string; message: string; report?: { count: number; names: string[] } }; cookieLength?: number };
  const login = () => run(async () => {
    const r = await api<CheckReply>('douyin/login', {});
    if (!r.ok) throw new Error(r.error ?? '登录失败');
    const ok = r.check?.api === 'ok';
    setNote(ok ? `登录成功：${r.check?.message ?? ''}` : `已存 Cookie，但${r.check?.message ?? '还没确认登录态'}`);
    bumpSecrets();
  });
  const check = () => run(async () => {
    const r = await api<CheckReply>('douyin/check', {});
    if (!r.ok) throw new Error(r.error ?? '检查失败');
    const report = r.check?.report;
    setNote(`${r.check?.message ?? '没有结果'}${report ? `（${report.count} 个键：${report.names.slice(0, 6).join('、')}${report.names.length > 6 ? '…' : ''}）` : ''}`);
    bumpSecrets();
  });
  return (
    <div className="dl-field">
      <label>
        抖音登录（搜索要用）
        {configured === null ? null : configured ? <span className="dl-tag dl-ok-tag">已配置</span> : <span className="dl-tag">未配置</span>}
      </label>
      <div className="dl-row">
        <button disabled={busy} onClick={login}>{busy ? '等登录…' : '用浏览器登录抖音'}</button>
        <button disabled={busy} onClick={check}>检查登录态</button>
      </div>
      <p className="dl-hint">{note || '会弹一个 Chrome 窗口：扫码或短信登录，登完自动关；存之前会用搜索接口验一遍。'}</p>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

function SecretField({ label, ref_, hint, configured }: { label: string; ref_: string; hint: string; configured: boolean | null }) {
  const [value, setValue] = useState('');
  const [busy, error, run] = useBusy();
  const creds = useCredentials();
  if (!creds) return <div className="dl-field"><label>{label}</label><p className="dl-hint">这个 DSH 没有凭据服务：用环境变量 {ref_} 提供。</p></div>;
  return (
    <div className="dl-field">
      <label>{label} {configured === null ? null : configured ? <span className="dl-tag dl-ok-tag">已配置</span> : <span className="dl-tag">未配置</span>}</label>
      <div className="dl-row">
        <input type="password" value={value} placeholder={configured ? '已保存（重新填写会覆盖）' : hint} onChange={(e) => setValue(e.target.value)} />
        <button disabled={busy || !value.trim()} onClick={() => run(async () => {
          await creds.set(ref_, value.trim());
          setValue('');
          bumpSecrets();
        })}>保存</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

/** 舞台服务器上的文件（角色插画、模板预览图）：控制台用 OBS 地址里的 token 去取 */
function stageFile(stageUrl: string | undefined, kind: 'characters' | 'templates', id: string, file: string): string {
  if (!stageUrl) return '';
  const url = new URL(stageUrl);
  return `${url.origin}/${kind}/${id}/${encodeURIComponent(file)}?token=${url.searchParams.get('token') ?? ''}`;
}

function Img({ src, className, fallback = null }: { src: string; className: string; fallback?: React.ReactNode }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) return <>{fallback}</>;
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

// ── 控制台 ────────────────────────────────────────────

export function Console() {
  const svc = useServices();
  const { status, feed, focus, brainDetail, broadcast: liveBc } = useLive();
  const [host, setHost] = useState<HostState | null>(null);
  const [busy, error, run] = useBusy();
  const [room, setRoom] = useState('');
  const [copied, setCopied] = useState<'local' | 'lan' | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [dock, setDock] = useState<'owner' | 'sim'>('owner');
  const previewRef = useRef<HTMLDivElement>(null);
  const secrets = useSecrets();

  const refresh = () => api('state').then((s) => {
    setHost(s);
    const saved = s.settings.platform === 'douyin' ? s.settings.douyinRoom : s.settings.roomId;
    setRoom((r) => r || (saved ? String(saved) : ''));
  });
  useEffect(() => { void refresh().catch(() => {}); }, []);

  const show = status ?? host?.show ?? null;
  const settings = host?.settings;

  const goLive = () => run(async () => {
    if (!svc) throw new Error('插件还没准备好，刷新一下页面再试。');
    // 推流到 B 站：先开播拿推流码、OBS 推上流（可能要扫码人脸认证），推上了她再开口
    if (settings?.broadcast) {
      await api('broadcast/start', {});
      await waitBroadcast();
    }
    const sessionId = await createBrainSession(svc);
    // 游戏线：没装 dsh-game（预设里没有游戏工具）也开得出来，只是用不上
    const gameSessionId = await createBrainSession(svc, 'game').catch(() => undefined);
    await api('onair', { sessionId, gameSessionId });
    await refresh();
  });

  const endLive = () => run(async () => { await api('offair', {}); await refresh(); });

  const platform = settings?.platform ?? 'bilibili';

  const saveRoom = () => run(async () => {
    const digits = Number(room);
    setHost(await api('settings', platform === 'douyin' ? { douyinRoom: digits } : { roomId: digits }));
    setHost(await api('connect', {}));
  });

  /** 换平台：先断开（不然两边的心跳会打架），再把房间号输入框换成这个平台记住的那个 */
  const choosePlatform = (next: 'bilibili' | 'douyin') => run(async () => {
    if (next === platform) return;
    await api('disconnect', {});
    const state = await api('settings', { platform: next });
    setHost(state);
    const saved = next === 'douyin' ? state.settings.douyinRoom : state.settings.roomId;
    setRoom(saved ? String(saved) : '');
  });

  const choose = (patch: Record<string, unknown>) => run(async () => setHost(await api('settings', patch)));
  // 换了主题：预览重新打开、演示一遍开场动画和直播中的样子（直播中不演示，直接换）
  const [demo, setDemo] = useState(0);
  const chooseTheme = (id: string) => run(async () => {
    setHost(await api('settings', { template: id }));
    if (!(status ?? host?.show)?.onAir) setDemo((n) => n + 1);
  });

  const copyStageUrl = (kind: 'local' | 'lan') => {
    const url = kind === 'lan' ? host?.stageLanUrl : host?.stageUrl;
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied((current) => current === kind ? null : current), 1500);
    });
  };
  const copyUrl = () => copyStageUrl('local');
  const copyLanUrl = () => copyStageUrl('lan');

  const bc = liveBc ?? host?.broadcast ?? null;
  const conn = show?.live.state ?? 'idle';
  const connTone = conn === 'connected' ? 'ok' : conn === 'error' ? 'bad' : conn === 'idle' ? 'idle' : 'warn';
  const previewUrl = host ? `${host.stageUrl}&preview=1${demo ? `&demo=${demo}` : ''}` : '';
  const brainTone = !show?.onAir ? 'idle' : show.brain === 'away' ? 'bad' : show.brain === 'speaking' ? 'warn' : 'ok';
  const brainText = show?.onAir ? (show.brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[show.brain]) : '没在播';
  const pending = show ? (show.pending.chats ?? 0) + (show.pending.gifts ?? 0) + (show.pending.thanks ?? 0) + (show.pending.superchats ?? 0) : 0;
  const character = settings?.character ?? '';

  // 开播前准备：缺什么一眼看到，点一下打开设置
  const steps = [
    { key: 'tts', done: secrets.tts === true, text: '豆包语音 Key', hint: '她要出声' },
    { key: 'obs', done: !!show?.stageWatchers, text: 'OBS 打开舞台', hint: '复制下面的舞台地址' },
    { key: 'room', done: conn === 'connected', text: '连上直播间', hint: '不连也能用模拟观众彩排' },
    { key: 'cookie', done: platform === 'douyin' ? secrets.douyin === true : secrets.cookie === true, text: platform === 'douyin' ? '抖音 Cookie（可选）' : 'B 站 Cookie', hint: '看到观众的完整名字' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className={`dl-room${show?.onAir ? ' dl-live' : ''}`}>
      <div className="dl-page">
        <header className="dl-top">
          <div className="dl-brand">
            <span className="dl-avatar">
              <Img className="dl-avatar-img" src={stageFile(host?.stageUrl, 'characters', character, 'art/portrait.webp')} fallback={<BroadcastGlyph />} />
            </span>
            <div className="dl-brand-text">
              <h1>大肥鱼直播{show?.onAir ? <span className="dl-onair"><i />LIVE</span> : <span className="dl-offair">未开播</span>}</h1>
              <div className="dl-pills">
                <span className="dl-pill"><Dot tone={brainTone} />{brainText}</span>
                <span className="dl-pill"><Dot tone={connTone} />直播间{CONN_TEXT[conn] ?? conn}{show?.live.room?.title ? ` · ${show.live.room.title}` : ''}</span>
                <span className="dl-pill"><Dot tone={show?.stageWatchers ? 'ok' : 'idle'} />{show?.stageWatchers ? `OBS 已连上 ${show.stageWatchers} 个` : 'OBS 还没打开舞台'}</span>
                {bc && bc.phase !== 'idle' && <BroadcastPill bc={bc} />}
              </div>
            </div>
          </div>
          <div className="dl-top-actions">
            <button className="dl-icon-btn" title="设置" onClick={() => setDrawer(true)}><GearGlyph /><span>设置</span></button>
            {!show?.onAir && (
              <button className={`dl-switch${settings?.broadcast ? ' dl-on' : ''}`} disabled={busy} title="关着：只在本地彩排（OBS 不推流）；开着：开播时真的推流到 B 站" onClick={() => choose({ broadcast: !settings?.broadcast })}>
                <i /><span>{settings?.broadcast ? '推流到 B 站' : '本地彩排'}</span>
              </button>
            )}
            {show?.onAir
              ? <button className="dl-btn dl-danger" disabled={busy} onClick={endLive}>下播（先让她道别）</button>
              : <button className="dl-btn dl-primary" disabled={busy || bc?.phase === 'preparing' || bc?.phase === 'face'} onClick={goLive}><i className="dl-go-dot" />{settings?.broadcast ? '开播' : '开始彩排'}</button>}
          </div>
        </header>
        {error && <p className="dl-error dl-banner">{error}</p>}
        {bc?.phase === 'error' && bc.error && error !== bc.error && <p className="dl-error dl-banner">{bc.error}</p>}
        {bc?.phase === 'error' && bc.error && /60043|实名|风控|拒绝接口开播/.test(bc.error) && (
          <div className="dl-banner-fix">
            <button className="dl-btn" onClick={() => window.open('https://link.bilibili.com/p/center/index#/user-center/my-info/account', '_blank', 'noopener')}>去 B 站做实名/开播人认证</button>
            <button className="dl-btn" onClick={() => window.open('https://link.bilibili.com/p/center/index', '_blank', 'noopener')}>打开直播中心</button>
            <button className="dl-btn dl-primary" disabled={busy} onClick={goLive}>认证完了，重试开播</button>
            <span className="dl-meta">补完实名后回到这里点重试，插件就能自己开播了</span>
          </div>
        )}
        {bc?.phase === 'face' && bc.faceQr && <FaceModal qr={bc.faceQr} onCancel={() => run(async () => { await api('broadcast/stop', {}); await refresh(); })} />}

        {!show?.onAir && doneCount < steps.length && (
          <div className="dl-checklist">
            <b>开播前准备 <em>{doneCount}/{steps.length}</em></b>
            {steps.map((s) => (
              <button key={s.key} className={s.done ? 'dl-step dl-step-done' : 'dl-step'} onClick={() => { if (s.key === 'obs') copyUrl(); else setDrawer(true); }}>
                <i>{s.done ? '✓' : ''}</i><span>{s.text}</span><small>{s.hint}</small>
              </button>
            ))}
          </div>
        )}

        <div className="dl-grid">
          <main className="dl-main">
            <section className="dl-monitor">
              <div className="dl-preview" ref={previewRef}>
                {previewUrl && <iframe src={previewUrl} title="舞台预览" />}
                <button className="dl-fullscreen" title="全屏看舞台（Esc 退出）" onClick={() => void previewRef.current?.requestFullscreen?.()}><FullscreenGlyph /><span>全屏</span></button>
                <span className={`dl-preview-tag${show?.onAir ? ' dl-preview-live' : ''}`}><i />{show?.onAir ? '直播中 · 和 OBS 里一样（静音）' : '预览：开播后的样子 · OBS 里现在是「马上开始」的等待画面'}</span>
              </div>
              <div className="dl-monitor-bar">
                <div className="dl-obs">
                  <span className="dl-label">OBS 浏览器源</span>
                  <code onClick={copyUrl} title="点一下复制">{host?.stageUrl ?? ''}</code>
                  <button className={copied === 'local' ? 'dl-done' : ''} onClick={copyUrl}>{copied === 'local' ? '已复制' : '复制'}</button>
                  <span className="dl-meta">1920 × 1080</span>
                </div>
                {host?.stageLanUrl && (
                  <div className="dl-obs">
                    <span className="dl-label">手机 / 局域网</span>
                    <code onClick={copyLanUrl} title="点一下复制；手机需与电脑连接同一网络">{host.stageLanUrl}</code>
                    <button className={copied === 'lan' ? 'dl-done' : ''} onClick={copyLanUrl}>{copied === 'lan' ? '已复制' : '复制'}</button>
                    <span className="dl-meta">同一 Wi-Fi</span>
                  </div>
                )}
              </div>
              <div className="dl-skins">
                <span className="dl-label">主题</span>
                <div className="dl-skin-list">
                  {host && [...host.templates].sort((a, b) => Number(b.id === 'default') - Number(a.id === 'default')).map((t) => (
                    <button key={t.id} className={`dl-skin${t.id === settings?.template ? ' dl-on' : ''}`} onClick={() => chooseTheme(t.id)}>
                      <Img className="dl-skin-img" src={`${stageFile(host.stageUrl, 'templates', t.id, 'preview.jpg')}&v=${t.stamp ?? 0}`} fallback={<span className="dl-skin-img dl-skin-blank" />} />
                      <b>{t.name}</b>{t.builtin ? null : <small>自定义</small>}
                    </button>
                  ))}
                </div>
                {host && host.characters.length > 1 && (
                  <>
                    <span className="dl-label">角色</span>
                    <div className="dl-chips">
                      {host.characters.map((c) => <button key={c.id} className={c.id === settings?.character ? 'dl-on' : ''} onClick={() => choose({ character: c.id })}>{c.name}</button>)}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="dl-dock">
              <nav className="dl-tabs">
                <button className={dock === 'owner' ? 'dl-on' : ''} onClick={() => setDock('owner')}>跟她说话</button>
                <button className={dock === 'sim' ? 'dl-on' : ''} onClick={() => setDock('sim')}>模拟观众</button>
                <span className="dl-meta">{dock === 'owner' ? '观众也会听到她的回答' : '不开直播间也能彩排'}</span>
              </nav>
              {dock === 'owner' ? <OwnerSay onAir={!!show?.onAir} /> : <Simulator />}
            </section>
          </main>

          <aside className="dl-side">
            <div className="dl-side-head">
              <div className="dl-now"><Dot tone={brainTone} /><b>{brainText}</b></div>
              <div className="dl-stats">
                <div><b>{show?.live.stats.online ?? '–'}</b><span>在线</span></div>
                <div><b>{show?.live.perMinute.chat ?? 0}</b><span>弹幕/分</span></div>
                <div><b>{show ? { quiet: '冷清', normal: '一般', busy: '热闹' }[show.heat] ?? show.heat : '–'}</b><span>热度</span></div>
                <div className={pending ? 'dl-hot' : ''}><b>{pending}</b><span>待回应</span></div>
              </div>
            </div>
            <Feed feed={feed} focus={focus} sleep={stageFile(host?.stageUrl, 'characters', character, 'art/sleep.webp')} />
            {show?.brainSession && (
              <div className="dl-links">
                <button className="dl-link" onClick={() => svc?.uiWorkspace.openSession(show.brainSession!)}>打开她直播的会话 →</button>
                {show.onAir && <button className="dl-link" onClick={() => svc && void cancel(svc, show.brainSession!)}>让她停下这一轮</button>}
              </div>
            )}
          </aside>
        </div>
      </div>

      {drawer && (
        <div className="dl-drawer-wrap" onClick={() => setDrawer(false)}>
          <aside className="dl-drawer" onClick={(e) => e.stopPropagation()}>
            <header><h2>设置</h2><button className="dl-icon-btn" onClick={() => setDrawer(false)}>关闭</button></header>
            <h3>直播间</h3>
            <div className="dl-field">
              <div className="dl-chips">
                {PLATFORMS.map((p) => (
                  <button key={p.id} className={platform === p.id ? 'dl-on' : ''} disabled={busy || show?.onAir} onClick={() => choosePlatform(p.id)}>{p.name}</button>
                ))}
                <span className="dl-meta">{show?.onAir ? '直播中不能换平台' : '换平台会先断开现在的直播间'}</span>
              </div>
              <label>{platform === 'douyin' ? '抖音直播间号' : 'B 站直播间房间号'}</label>
              <div className="dl-row">
                <input value={room} inputMode="numeric" placeholder={PLATFORMS.find((p) => p.id === platform)?.roomHint} onChange={(e) => setRoom(e.target.value.replace(/\D/g, ''))} />
                {conn === 'idle' || conn === 'error'
                  ? <button disabled={busy || !room} onClick={saveRoom}>连接</button>
                  : <button disabled={busy} onClick={() => run(async () => setHost(await api('disconnect', {})))}>断开</button>}
              </div>
              {platform === 'douyin' ? (
                <>
                  <label>浏览器程序（抖音弹幕要用真 Chrome 连，一般不用填）</label>
                  <div className="dl-row">
                    <input
                      key={settings?.douyinBrowser ?? ''}
                      defaultValue={settings?.douyinBrowser ?? ''}
                      placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
                      onBlur={(e) => choose({ douyinBrowser: e.target.value })}
                    />
                    {settings?.douyinBrowser ? <button disabled={busy} onClick={() => choose({ douyinBrowser: '' })}>清空</button> : null}
                  </div>
                  <p className="dl-hint">这里要填 exe 的路径，不是直播间链接（直播间号填上面那一格）；空着会自动找 Chrome / Edge。</p>
                </>
              ) : null}
              {platform === 'bilibili' ? (
                <>
                  <label className="dl-check">
                    <input
                      type="checkbox"
                      checked={!!settings?.douyinAlsoListen}
                      onChange={(e) => choose({ douyinAlsoListen: e.target.checked })}
                    /> B 站 播着的时候，也收抖音直播间的弹幕
                  </label>
                  <p className="dl-hint">
                    抖音那边同时也开着播时勾上：两个直播间的弹幕/礼物都会交给她（主直播间仍是 B 站）。
                    要先填「抖音直播间号」，并在「密钥」里登录抖音；不勾就只收 B 站。
                  </p>
                </>
              ) : null}
              {(platform === 'douyin' ? settings?.douyinRoom : settings?.roomId) ? (
                <label className="dl-check">
                  <input
                    type="checkbox"
                    checked={(platform === 'douyin' ? settings?.ownDouyinRooms ?? [] : settings?.ownRooms ?? []).includes((platform === 'douyin' ? settings?.douyinRoom : settings?.roomId)!)}
                    onChange={(e) => choose({ ownRoom: e.target.checked })}
                  /> 这是我自己的直播间：记住常来的观众（别人的直播间只旁观，不记）
                </label>
              ) : null}
              {show?.live.state === 'connected' && !show.live.loggedIn && (
                <p className="dl-hint">
                  {platform === 'douyin'
                    ? '抖音弹幕借你机器上的 Chrome 连（窗口挪在屏幕外）；没填抖音 Cookie 时观众名字会打码。'
                    : '匿名连接：部分观众的名字会被 B 站打码。填上 Cookie 就能看到完整名字。'}
                </p>
              )}
              {show?.live.lastError && <p className="dl-error">{show.live.lastError}</p>}
            </div>
            {platform === 'douyin' ? (
              <p className="dl-hint">
                抖音这边只用它读弹幕/礼物；开播推流还走本机的 OBS + B 站（下面这一节）。抖音自己的开播要走抖音直播伴侣，
                把 OBS 的画面推过去就行。
              </p>
            ) : null}
            <h3>推流到 B 站</h3>
            <ObsCheck />
            <PreflightCheck />
            <div className="dl-field">
              <label>直播标题（开播前改成这个；空着就用 B 站上现在的）</label>
              <input defaultValue={settings?.liveTitle ?? ''} maxLength={40} placeholder="比如：大肥鱼的深夜食堂" onBlur={(e) => choose({ liveTitle: e.target.value })} />
            </div>
            <div className="dl-field">
              <label>直播分区 id（子分区；空着就用 B 站给这个账号准备的默认分区）</label>
              <input defaultValue={settings?.areaId ?? ''} inputMode="numeric" placeholder="比如 371（虚拟日常）" onBlur={(e) => { const digits = e.target.value.replace(/\D/g, ''); choose({ areaId: digits ? Number(digits) : null }); }} />
              <div className="dl-row">
                <select value={settings?.pushProtocol ?? 'srt'} onChange={(e) => choose({ pushProtocol: e.target.value })}>
                  <option value="srt">SRT（推荐：跨境、Wi-Fi 更稳）</option>
                  <option value="rtmp">RTMP</option>
                </select>
                <input defaultValue={settings?.streamKbps ?? 4500} inputMode="numeric" title="码率 kbps" onBlur={(e) => choose({ streamKbps: Number(e.target.value.replace(/\D/g, '')) || 4500 })} />
                <span className="dl-meta">kbps</span>
              </div>
              <p className="dl-hint">开播时：没有直播间会自动开通；B 站要人脸认证时这里弹出二维码，用 B 站 App 扫一下；推流码自动填进 OBS（专用配置「dsh-livestreamingcompanion」，1080p30、NVENC、CBR，RTMP 网络堵时自动降码率），不用手动配 OBS。推流时上面会显示码率和丢帧，丢帧多就换 SRT 或调低码率。</p>
            </div>

            {/* B 站接口回 60043（风控/实名）时的救急通道：用直播姬「第三方推流」给的码，跳过 startLive */}
            <details className="dl-field dl-manual-push">
              <summary>B 站拒绝接口开播？用直播姬的推流码开（绕过风控）</summary>
              <p className="dl-hint">
                直播姬右上角齿轮 → 推流方式改成「第三方推流」，会给你「推流地址」和「推流码」。
                把两段填在下面，开播时插件就不再调 B 站开播接口，直接把 OBS 推到这对地址上（B 站照样能收到画面）。
                清空这两个框就恢复自动开播。
              </p>
              <div className="dl-field">
                <label>推流地址</label>
                <input
                  key="manual-addr"
                  defaultValue={settings?.manualPushAddr ?? ''}
                  placeholder="rtmp://txy.live-send.acg.tv/live/  （srt:// 也行）"
                  onBlur={(e) => choose({ manualPushAddr: e.target.value })}
                />
              </div>
              <div className="dl-field">
                <label>推流码</label>
                <input
                  key="manual-code"
                  defaultValue={settings?.manualPushCode ?? ''}
                  placeholder="房间号-一串密钥"
                  onBlur={(e) => choose({ manualPushCode: e.target.value })}
                />
              </div>
            </details>
            {/* 多平台推流：你平时用 OBS 直推 B 站，这块用不到 → 默认折叠，需要时再展开 */}
            <details className="dl-push-wrap">
              <summary>
                <b>多平台推流</b>
                <span className="dl-meta">同一份画面同时推抖音/快手/视频号…（不用 OBS 时才用）</span>
              </summary>
              <MultiPush obsStreaming={bc?.phase === 'streaming'} />
            </details>
            <h3>她的声音</h3>
            <div className="dl-field">
              <div className="dl-row">
                <select value={settings?.ttsBackend ?? 'doubao'} onChange={(e) => choose({ ttsBackend: e.target.value })}>
                  <option value="doubao">豆包云（带逐字字幕）</option>
                  <option value="gptsovits">本地 GPT-SoVITS（自训音色）</option>
                </select>
              </div>
              {settings?.ttsBackend === 'doubao' ? (
                <div className="dl-col">
                  <select value={settings?.voice ?? ''} onChange={(e) => choose({ voice: e.target.value })}>
                    <option value="">默认：萌丫头（甜）</option>
                    <option value="zh_female_wenjingmaomao_uranus_bigtts">文静毛毛（安静、呆萌）</option>
                    <option value="zh_female_yingtaowanzi_uranus_bigtts">樱桃丸子（卡通、憨萌）</option>
                    <option value="zh_female_xiaoxue_uranus_bigtts">儿童绘本（稚嫩童声）</option>
                    <option value="zh_female_peiqi_uranus_bigtts">佩奇猪（卡通、搞怪）</option>
                    <option value="ICL_uranus_zh_female_huopodiaoman_tob">活泼刁蛮（傲娇小公主）</option>
                    <option value="zh_female_zhixingnv_uranus_bigtts">知性女（稳）</option>
                    <option value="zh_female_tianmeixiaoyuan_uranus_bigtts">甜美小源（甜糯）</option>
                    <option value="zh_female_qingxinnvsheng_uranus_bigtts">清新女声（轻）</option>
                    <option value="zh_female_gaolengyujie_uranus_bigtts">高冷御姐（低）</option>
                    <option value="zh_female_wanwanxiaohe_uranus_bigtts">湾湾小何（软）</option>
                    <option value="zh_male_yuanboxiaoshu_uranus_bigtts">渊博小叔（男声）</option>
                  </select>
                  <p className="dl-hint">换音色下一句就生效。这些是豆包 2.0 音色，均已实际合成验证，带逐字时间。</p>
                </div>
              ) : null}
              {settings?.ttsBackend === 'gptsovits' ? (
                <div className="dl-col">
                  <input defaultValue={settings?.gptsovitsUrl ?? 'http://127.0.0.1:9880'} title="本地服务地址" placeholder="http://127.0.0.1:9880" onBlur={(e) => choose({ gptsovitsUrl: e.target.value })} />
                  <input defaultValue={settings?.gptsovitsRef ?? ''} title="参考音频路径" placeholder="参考音频：dafeiyu_ref.wav 的完整路径（3~10 秒干净人声）" onBlur={(e) => choose({ gptsovitsRef: e.target.value })} />
                  <input defaultValue={settings?.gptsovitsPrompt ?? ''} title="参考音频对应文本" placeholder="参考文本：那句音频里说的原话" onBlur={(e) => choose({ gptsovitsPrompt: e.target.value })} />
                  <p className="dl-hint">先在本地起 GPT-SoVITS 的 api_v2.py（默认 9880 端口）。本地合成不返回逐字时间，字幕按念出来的时长均匀走，不像豆包那样一个字一个字精确对齐。</p>
                </div>
              ) : null}
              <p className="dl-hint">改完立刻生效，不用重启。</p>
            </div>
            <h3>告示板</h3>
            <BoardField value={settings?.boardText ?? ''} fallback={host?.defaultBoard ?? ''} onSave={(boardText) => choose({ boardText })} />
            <h3>滚动通知</h3>
            <div className="dl-field">
              <div className="dl-row">
                <input key={settings?.noticeText ?? ''} defaultValue={settings?.noticeText ?? ''} placeholder="比如：游戏画面卡住了，主人在修，马上回来" onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={(e) => { if (e.target.value.trim() !== (settings?.noticeText ?? '')) choose({ noticeText: e.target.value }); }} />
                <button type="button" onClick={() => choose({ noticeText: '' })}>收起</button>
              </div>
              <p className="dl-hint">写了就在画面最底下滚动，告诉观众现在出了什么状况；回车生效，「收起」就不显示了。</p>
            </div>
            <h3>节奏</h3>
            <div className="dl-field">
              <div className="dl-row">
                <input defaultValue={settings?.idleAfterSec ?? 45} inputMode="numeric" title="找话说（秒）" onBlur={(e) => choose({ idleAfterSec: Number(e.target.value.replace(/\D/g, '')) || 45 })} />
                <span className="dl-meta">秒：直播间没动静这么久，她自己找话说</span>
              </div>
              <div className="dl-row">
                <input defaultValue={settings?.gameChatGapSec ?? 15} inputMode="numeric" title="弹幕间隔（秒）" onBlur={(e) => choose({ gameChatGapSec: Number(e.target.value.replace(/\D/g, '')) || 15 })} />
                <span className="dl-meta">秒：玩游戏时弹幕至少隔这么久推给她一次</span>
              </div>
              <div className="dl-pace">
                {PACE_FIELDS.map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input key={String(settings?.pace?.[key] ?? '')} defaultValue={String(settings?.pace?.[key] ?? '')} placeholder="自动"
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(settings?.pace?.[key] ?? '')) choose({ pace: { [key]: key === 'welcomeSec' && /^(off|关)$/i.test(v) ? 'off' : v } as never }); }} />
                  </label>
                ))}
              </div>
              <p className="dl-hint">都是改了马上生效，不用重启。留空就按直播间热闹程度自动（人少时回得勤、人多时攒一攒）；现场不合适就直接填：间隔填秒数，「欢迎」填 off 就不欢迎新进来的观众。大礼物、醒目留言、上舰不受这些间隔限制。</p>
            </div>
            <h3>看视频</h3>
            <div className="dl-field">
              <label>语音识别用的 Python {host?.asr.available ? <span className="dl-tag dl-ok-tag">能用</span> : <span className="dl-tag">没配好</span>}</label>
              <input defaultValue={settings?.asrPython ?? ''} placeholder="装了 faster-whisper 的 python.exe 的完整路径" onBlur={(e) => choose({ asrPython: e.target.value })} />
              <div className="dl-row">
                <input defaultValue={settings?.asrModel ?? 'large-v3-turbo'} title="whisper 模型" onBlur={(e) => choose({ asrModel: e.target.value })} />
                <span className="dl-meta">模型：有 N 卡用 large-v3-turbo，只有 CPU 用 small</span>
              </div>
              <p className="dl-hint">她看的 B 站视频没有字幕时，用本机的 faster-whisper 听一段（5 分钟一段，显卡上几秒）写成字幕给她看。不填就只告诉她「没有字幕」。装法：<code>python -m venv asr-venv</code>，再 <code>asr-venv\Scripts\python -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12</code>（没有 N 卡只装 faster-whisper）。模型第一次用时自动下载（约 1.6 GB，走 hf-mirror 镜像）。</p>
            </div>
            <h3>密钥</h3>
            <SecretField label="豆包语音 API Key" ref_={SECRET_REFS.tts} configured={secrets.tts} hint="火山引擎新版控制台的 API Key（和 dsh-game 共用）" />
            <LoginField />
            <SecretField label="B 站 Cookie（不想扫码时手填）" ref_={SECRET_REFS.cookie} configured={secrets.cookie} hint="浏览器里登录 B 站后复制的 Cookie；扫码登录会自动填这一项" />
            <SecretField label="抖音 Cookie（可选：只为了让观众名字不打码）" ref_={SECRET_REFS.douyin} configured={secrets.douyin} hint="浏览器里登录抖音后复制的整条 Cookie；不填也能连直播间，匿名进房时观众名字是「张***」这种" />
            <DouyinLogin configured={secrets.douyin} />
            <h3>舞台</h3>
            <div className="dl-field">
              <label>OBS 舞台地址（来源 → 浏览器 → 粘贴，宽 1920 高 1080）</label>
              <div className="dl-row">
                <input readOnly value={host?.stageUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
                <button className={copied === 'local' ? 'dl-done' : ''} onClick={copyUrl}>{copied === 'local' ? '已复制' : '复制'}</button>
              </div>
              {host?.stageLanUrl && (
                <>
                  <label>手机 / 局域网舞台地址</label>
                  <div className="dl-row">
                    <input readOnly value={host.stageLanUrl} onFocus={(e) => e.currentTarget.select()} />
                    <button className={copied === 'lan' ? 'dl-done' : ''} onClick={copyLanUrl}>{copied === 'lan' ? '已复制' : '复制'}</button>
                  </div>
                  <p className="dl-hint">手机与电脑连接同一 Wi-Fi 后打开完整地址（包括 token）。仅在可信局域网使用，不要发到直播间或映射到公网；普通 HTTP 预览不支持手机摄像头采集。</p>
                </>
              )}
              <p className="dl-hint">想做自己的主题：把插件里 assets/templates/default 复制到 DSH 主目录的 dsh-livestream/templates/&lt;新名字&gt;/，改 template.json 的 id 和 name。</p>
              <label className="dl-check">
                <input
                  type="checkbox"
                  checked={settings?.showTerminal ?? true}
                  onChange={(e) => choose({ showTerminal: e.target.checked })}
                /> 显示终端聊天框
              </label>
              <p className="dl-hint">关闭后隐藏直播画面里的「dafeiyu@live」面板；字幕、弹幕和游戏画面不受影响。切换后立即生效。</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** 等推流准备好：推上了返回；出错、取消就抛出（人脸认证最多等 5 分钟，宿主那边会超时） */
async function waitBroadcast(): Promise<void> {
  const deadline = Date.now() + 7 * 60_000;
  await new Promise((r) => setTimeout(r, 1200));
  while (Date.now() < deadline) {
    const bc = live.broadcast;
    if (bc?.phase === 'streaming') return;
    if (bc?.phase === 'error') throw new Error(bc.error ?? '推流失败');
    if (bc?.phase === 'idle' || bc?.phase === 'stopping') throw new Error('推流取消了');
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等推流等太久了');
}

const PHASE_TEXT = { idle: '', preparing: '准备推流', face: '等人脸认证', streaming: '推流中', stopping: '正在下播', error: '推流出错' } as const;

function BroadcastPill({ bc }: { bc: BroadcastStatus }) {
  const tone = bc.phase === 'streaming' ? 'ok' : bc.phase === 'error' ? 'bad' : 'warn';
  const h = bc.health;
  const dropped = h && h.total ? ((h.skipped / h.total) * 100).toFixed(1) : null;
  return (
    <span className="dl-pill" title={bc.step}>
      <Dot tone={tone} />B 站 · {bc.phase === 'streaming' && h ? `${h.kbps} kbps · 丢帧 ${dropped ?? 0}% · ${h.timecode.slice(0, 8)}` : bc.step || PHASE_TEXT[bc.phase]}
    </span>
  );
}

/** 开播账号：现在登的是谁；扫码登录（B 站 App 扫一下，Cookie 由插件自己存进凭据） */
function LoginField() {
  const [account, setAccount] = useState<{ uid: number; name: string } | null | undefined>(undefined);
  const [qr, setQr] = useState<{ img: string; key: string } | null>(null);
  const [status, setStatus] = useState('');
  const refresh = () => void api<{ ok: boolean; account: { uid: number; name: string } | null }>('account').then((r) => setAccount(r.account)).catch(() => setAccount(null));
  useEffect(refresh, []);
  useEffect(() => {
    if (!qr) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await api<{ ok: boolean; state: string; message?: string; account?: { uid: number; name: string } }>('login/poll', { key: qr.key });
        if (r.state === 'ok') { setQr(null); setStatus(''); setAccount(r.account ?? null); return; }
        if (r.state === 'expired') { setQr(null); setStatus('二维码过期了，再点一次扫码登录'); return; }
        if (r.state === 'error') { setQr(null); setStatus(r.message ?? '登录失败'); return; }
        setStatus(r.state === 'scanned' ? '扫好了，在 App 上点确认登录' : '用 B 站 App 扫这个码（开播用的那个账号）');
      } catch (err) {
        setStatus((err as Error).message);
      }
      setTimeout(tick, 2000);
    };
    void tick();
    return () => { stopped = true; };
  }, [qr?.key]);
  const start = async () => {
    setStatus('');
    try {
      const r = await api<{ ok: boolean; url: string; key: string }>('login/start', {});
      setQr({ img: await QRCode.toDataURL(r.url, { margin: 1, width: 200 }), key: r.key });
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <div className="dl-field">
      <label>开播账号 {account ? <span className="dl-tag dl-ok-tag">已登录</span> : account === null ? <span className="dl-tag">没登录</span> : null}</label>
      <div className="dl-row">
        <span className="dl-meta" style={{ flex: 1 }}>{account ? `${account.name}（UID ${account.uid}）` : account === null ? '开播、私信、评论都要先登录' : '查询中…'}</span>
        <button onClick={() => void start()}>{account ? '换个账号' : '扫码登录'}</button>
      </div>
      {qr && <img src={qr.img} alt="B 站登录二维码" style={{ width: 200, height: 200, borderRadius: 12, marginTop: 8, background: '#fff' }} />}
      {status && <p className="dl-hint">{status}</p>}
    </div>
  );
}

/** 告示板：主人想让观众知道的。改完离开输入框就换到舞台上 */
/** 节奏里主人可以改的几项（秒；一次回几位是人数） */
const PACE_FIELDS = [['welcomeSec', '欢迎新观众间隔'], ['thanksSec', '谢小礼物间隔'], ['followSec', '谢关注间隔'], ['chatPicks', '一次回几位']] as const;

function BoardField({ value, fallback, onSave }: { value: string; fallback: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="dl-field">
      <label>直播画面上的告示板（空行分页，每页第一行是标题；清空就不显示）</label>
      <textarea value={text} rows={10} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />
      <div className="dl-row">
        <button disabled={text === fallback} onClick={() => { setText(fallback); onSave(fallback); }}>恢复默认</button>
        <span className="dl-meta">几页轮着放；开播时她也会知道上面写了什么</span>
      </div>
    </div>
  );
}

/** 开播前自检：真的向 B 站申请一次开播，拿到推流码就立刻下播，把卡在哪一步说清楚 */
function PreflightCheck() {
  const [busy, error, run] = useBusy();
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [probe, setProbe] = useState<ProbeRow[] | null>(null);
  return (
    <div className="dl-field">
      <div className="dl-row">
        <button disabled={busy} onClick={() => run(async () => setResult((await api<{ result: PreflightResult }>('broadcast/preflight', {})).result))}>
          {busy ? '自检中（约 5 秒）…' : '开播前自检'}
        </button>
        <button disabled={busy} title="同一次开播，用 5 种请求形状各试一次，看哪种 B 站放行" onClick={() => run(async () => {
          const r = await api<{ results: ProbeRow[] }>('broadcast/probe', {});
          setProbe(r.results);
        })}>接口探测</button>
        <span className="dl-meta">真的向 B 站试一次开播：拿到推流码就立刻下播，告诉你卡在哪一步</span>
      </div>
      {error && <p className="dl-error">{error}</p>}
      {probe && (
        <div className="dl-preflight">
          <b>接口探测结果（code 0 = 这种请求 B 站放行）</b>
          <ul>
            {probe.map((p) => (
              <li key={p.name}>
                <i className={`dl-dot ${p.code === 0 ? 'dl-ok' : 'dl-error'}`} />
                <span className="dl-preflight-label">{p.code}</span>
                <span className="dl-preflight-detail">
                  {p.name} · {p.message}
                  {p.needFaceAuth === null ? '' : ` · need_face_auth=${p.needFaceAuth}`}
                  {p.qr ? ' · 带 qr' : ''}
                  {p.hasRtmp ? ' · 拿到推流码' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result && (
        <div className={`dl-preflight${result.canStart ? ' dl-ok' : ''}`}>
          <b>{result.verdict}</b>
          <ul>
            {result.steps.map((s) => (
              <li key={s.key}>
                <i className={`dl-dot ${s.ok ? 'dl-ok' : 'dl-error'}`} />
                <span className="dl-preflight-label">{s.label}</span>
                <span className="dl-preflight-detail">{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 检查 OBS：打开 OBS、设好专用配置和场景，看一帧节目画面（不推流） */
function ObsCheck() {
  const [busy, error, run] = useBusy();
  const [result, setResult] = useState<{ image: string; profile: string; collection: string } | null>(null);
  return (
    <div className="dl-field">
      <div className="dl-row">
        <button disabled={busy} onClick={() => run(async () => setResult(await api<{ ok: boolean; image: string; profile: string; collection: string }>('obs/check', {})))}>{busy ? '正在打开 OBS…' : '检查 OBS'}</button>
        <span className="dl-meta">打开 OBS、设好画质和舞台，看一帧画面；不推流</span>
      </div>
      {error && <p className="dl-error">{error}</p>}
      {result && (
        <>
          <img src={result.image} alt="OBS 节目画面" style={{ width: '100%', borderRadius: 10, marginTop: 8 }} />
          <p className="dl-hint">OBS 配置「{result.profile}」· 场景集合「{result.collection}」</p>
        </>
      )}
    </div>
  );
}

// ── 多平台并行推流（生态那部分：一份画面同时推到抖音/快手/视频号/虎牙…）──────

interface PushPlatformInfo { id: string; label: string; server: string; hint: string }
interface PushTargetView { id: string; label: string; on: boolean; ready: boolean; error: string | null }
interface PushStateView {
  running: boolean; startedAt: number | null; input: string;
  engine: { path: string | null; version: string | null };
  targets: PushTargetView[]; error: string | null; log: string[];
}
interface PushConfigView {
  mode: string;
  ffmpegPath: string;
  input: string; window: string; region: { x: number; y: number; w: number; h: number };
  relayUrl: string; fps: number; width: number; height: number; kbps: number;
  targets: Record<string, { server: string; on: boolean; hasKey: boolean }>;
}

interface PreflightStepView { key: string; label: string; ok: boolean; detail: string }
interface PreflightResult { verdict: string; canStart: boolean; steps: PreflightStepView[]; qr?: string }

interface RelayView { running: boolean; exe: string | null; port: number; url: string; log: string[]; error: string | null }
interface ProbeRow { name: string; code: number; message: string; needFaceAuth: boolean | null; qr: string; hasRtmp: boolean }

const PUSH_INPUTS = [
  { id: 'desktop', label: '屏幕区域', note: '抓屏幕上的一块区域：把 OBS 预览或舞台窗口摆在这块里就行（没声音）' },
  { id: 'capture', label: '浏览器采集', note: '摄像头/屏幕采集，带声音（在 Chrome 里打开采集页）' },
];

function MultiPush({ obsStreaming = false }: { obsStreaming?: boolean }) {
  const [busy, error, run] = useBusy();
  const [platforms, setPlatforms] = useState<PushPlatformInfo[]>([]);
  const [state, setState] = useState<PushStateView | null>(null);
  const [config, setConfig] = useState<PushConfigView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<RelayView | null>(null);

  const load = () => api<{ state: PushStateView; config: PushConfigView }>('push/state').then((r) => {
    setState(r.state);
    setConfig(r.config);
    // 旧配置里可能还留着 simulate / stage / relay / test：界面上已经没有这些选项了，
    // 不迁就会点「开始推流」却只跑了个假推流（日志里能看到「模拟推流：1 路（未真的连平台）」）。
    if (r.config.mode !== 'ffmpeg' || (r.config.input !== 'capture' && r.config.input !== 'desktop')) {
      void api('push/config', { mode: 'ffmpeg', input: r.config.input === 'capture' ? 'capture' : 'desktop' })
        .then(() => api<{ state: PushStateView; config: PushConfigView }>('push/state'))
        .then((next) => { setState(next.state); setConfig(next.config); })
        .catch(() => {});
    }
  });
  const loadRelay = () => api<{ relay: RelayView }>('relay/state').then((r) => setRelayState(r.relay)).catch(() => {});

  useEffect(() => {
    void api<{ platforms: PushPlatformInfo[] }>('push/platforms').then((r) => setPlatforms(r.platforms)).catch(() => {});
    void load().catch(() => {});
    void loadRelay();
    const timer = setInterval(() => { void load().catch(() => {}); void loadRelay(); }, 3000);
    return () => clearInterval(timer);
  }, []);

  const patch = (body: unknown) => run(async () => {
    const r = await api<{ state: PushStateView; config: PushConfigView }>('push/config', body);
    setState(r.state);
    setConfig(r.config);
  });

  const toggle = (id: string, on: boolean) => patch({ target: { id, value: { on } } });
  const engine = state?.engine ?? { path: null, version: null };
  const targets = state?.targets ?? [];
  const active = targets.filter((t) => t.on && t.ready);
  const inputNote = PUSH_INPUTS.find((i) => i.id === (config?.input ?? 'capture'))?.note ?? '';

  // 推流时长每秒走一格（不用整页刷新）
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!state?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state?.running]);
  const startedAt = state?.startedAt ?? null;
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  // 日志去重：连续同样的行只留一行
  const logLines = (state?.log ?? []).filter((line, i, all) => line !== all[i - 1]);

  return (
    <div className="dl-push">
      <div className="dl-push-head">
        {/* 只剩两种画面来源：屏幕区域（默认，开箱能用）和浏览器采集（要摄像头/声音时用） */}
        <div className="dl-seg">
          <button className={config?.input !== 'capture' ? 'dl-on' : ''} onClick={() => patch({ input: 'desktop' })}>屏幕区域</button>
          <button className={config?.input === 'capture' ? 'dl-on' : ''} onClick={() => patch({ input: 'capture' })}>浏览器采集</button>
        </div>
        <span className="dl-meta">{inputNote}</span>
      </div>
      {config?.input === 'capture' && (
        <div className="dl-row">
          <button className="dl-icon-btn" disabled={busy} onClick={() => run(async () => {
            const r = await api<{ note: string }>('capture-window', {});
            window.alert(r.note);
          })}>在 Chrome 里打开采集页</button>
          <span className="dl-meta">摄像头/屏幕采集只能在真浏览器里做（DSH 客户端不给媒体权限）：打开后允许权限，再点开始推流</span>
        </div>
      )}
      {config?.input === 'desktop' && config && (
        <div className="dl-push-region">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label key={k}>
              <span>{k === 'w' ? '宽' : k === 'h' ? '高' : k.toUpperCase()}</span>
              <input
                defaultValue={config.region[k]}
                inputMode="numeric"
                onBlur={(e) => patch({ region: { ...config.region, [k]: Number(e.target.value.replace(/\D/g, '')) || 0 } })}
              />
            </label>
          ))}
        </div>
      )}

      <div className="dl-push-metrics">
        <label><span>帧率</span><input defaultValue={config?.fps ?? 30} inputMode="numeric" onBlur={(e) => patch({ fps: Number(e.target.value.replace(/\D/g, '')) || 30 })} /><em>fps</em></label>
        <label><span>码率</span><input defaultValue={config?.kbps ?? 4500} inputMode="numeric" onBlur={(e) => patch({ kbps: Number(e.target.value.replace(/\D/g, '')) || 4500 })} /><em>kbps</em></label>
        <label><span>分辨率</span><input defaultValue={`${config?.width ?? 1920}x${config?.height ?? 1080}`} onBlur={(e) => {
          const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(e.target.value.trim());
          if (m) void patch({ width: Number(m[1]), height: Number(m[2]) });
        }} /></label>
      </div>

      <div className="dl-push-engine">
        <i className={`dl-dot ${engine.path ? 'dl-ok' : 'dl-error'}`} />
        <span className="dl-push-engine-name">{engine.path ? `ffmpeg ${engine.version ?? ''}` : '未检测到 ffmpeg'}</span>
        <button className="dl-icon-btn" disabled={busy} onClick={() => run(async () => {
          const r = await api<{ result: { ok: boolean; path: string | null; version: string | null; error: string | null; note: string } }>('push/install', {});
          setState((await api<{ state: PushStateView }>('push/state')).state);
          window.alert(r.result.ok ? `ffmpeg 好了：${r.result.path ?? ''}\n${r.result.note}` : `没装成：${r.result.error ?? ''}`);
        })}>安装</button>
        <input
          key="push-ffmpeg-path"
          defaultValue={config?.ffmpegPath ?? ''}
          placeholder="或填 ffmpeg.exe 的完整路径（空着走 PATH）"
          onBlur={(e) => patch({ ffmpegPath: e.target.value })}
        />
      </div>

      {/* 本地中继：一条命令的落点，推完能立刻用 ffplay / HLS 页面验收 */}
      <div className="dl-push-engine">
        <i className={`dl-dot ${relayState?.running ? 'dl-ok' : 'dl-idle'}`} />
        <span className="dl-push-engine-name" title={relayState?.url ?? ''}>
          {relayState?.running ? '本地中继 :1935 就绪' : '本地中继未启动'}
        </span>
        <button className="dl-icon-btn" disabled={busy} onClick={() => run(async () => {
          const r = await api<{ relay: RelayView }>(relayState?.running ? 'relay/stop' : 'relay/start', {});
          setRelayState(r.relay);
          if (r.relay.error) window.alert(r.relay.error);
        })}>{relayState?.running ? '停止' : '启动'}</button>
        <button
          className="dl-icon-btn"
          disabled={busy || !relayState?.running}
          title="把「自定义」填成中继地址并选中"
          onClick={() => patch({ target: { id: 'custom', value: { server: 'rtmp://127.0.0.1:1935/live', key: 'dafeiyu', on: true } } })}
        >填入自定义</button>
      </div>

      <div className="dl-push-platforms">
        {targets.map((t) => (
          <button
            key={t.id}
            className={`dl-push-plat${t.on ? ' dl-on' : ''}${(editing ?? 'custom') === t.id ? ' dl-editing' : ''}`}
            title="点一下：选中/取消推流，并在下面编辑它的推流码"
            onClick={() => { setEditing(t.id); void toggle(t.id, !t.on); }}
          >
            <span className="dl-push-plat-name">{t.label}</span>
            <span className={`dl-push-plat-state ${t.ready ? 'dl-ok' : 'dl-warn'}`}>{t.ready ? '已配置' : '缺推流码'}</span>
          </button>
        ))}
      </div>

      {/* 配置卡常驻：不再需要先点标签才出现，上面用下拉切平台 */}
      {config && (() => {
        const id = editing ?? 'custom';
        const info = platforms.find((p) => p.id === id);
        const hasKey = !!config.targets[id]?.hasKey;
        return (
          <div className="dl-push-card">
            <div className="dl-push-card-head">
              <select value={id} onChange={(e) => setEditing(e.target.value)}>
                {platforms.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <span className={`dl-tag ${hasKey ? 'dl-ok-tag' : ''}`}>{hasKey ? '推流码已配置' : '还没填推流码'}</span>
            </div>
            <label>推流地址</label>
            <input
              key={`${id}-server`}
              defaultValue={config.targets[id]?.server || info?.server || ''}
              placeholder="例如 rtmp://push-douyin-pub.douyinstatic.com/live"
              onBlur={(e) => patch({ target: { id, value: { server: e.target.value.trim() } } })}
            />
            <label>推流码</label>
            <input
              key={`${id}-key`}
              placeholder={hasKey ? '已保存；要换就整段粘进来' : '从开播工具里复制（房间号-密钥 / 或任意名字）'}
              onBlur={(e) => { const v = e.target.value.trim(); if (v) void patch({ target: { id, value: { key: v } } }); e.target.value = ''; }}
            />
            <div className="dl-push-card-foot">
              <button className="dl-icon-btn" onClick={() => patch({ target: { id, value: { server: info?.server ?? '' } } })}>用默认地址</button>
              <button
                className="dl-icon-btn"
                onClick={() => patch({ target: { id, value: { on: !(config.targets[id]?.on ?? false) } } })}
              >{config.targets[id]?.on ? '取消选中' : '选中推流'}</button>
              <p className="dl-hint">{info?.hint}</p>
            </div>
          </div>
        );
      })()}

      <div className="dl-push-actions">
        <button
          className="dl-primary"
          disabled={busy || !engine.path || active.length === 0}
          title={active.length === 0 ? '先选平台并填好推流码' : '不拦你：OBS 在推也照推，冲突看下面的日志'}
          onClick={() => run(async () => setState((await api<{ state: PushStateView }>('push/start', {})).state))}
        >{state?.running ? '重新开始' : '开始推流'}</button>
        <button disabled={busy || !state?.running} onClick={() => run(async () => setState((await api<{ state: PushStateView }>('push/stop', {})).state))}>停止</button>
        <span className={`dl-push-status${state?.running ? ' dl-live' : ''}`}>
          <i className={`dl-dot ${state?.running ? 'dl-ok' : 'dl-idle'}`} />
          {state?.running ? `推流中 · ${active.length} 路 · ${clock}` : '未推流'}
        </span>
      </div>

      {/* 不拦，只提醒：OBS 在推 B站 的时候这里也勾了 B站，两条会同时推，结果看日志 */}
      {obsStreaming && config?.targets?.bilibili?.on && (
        <p className="dl-push-note dl-push-warn">
          OBS 正在推 B站，这里也勾着 B站：两个会同时推同一路。能不能并推、还是互相顶掉，看下面 ffmpeg 日志（不拦你）。
        </p>
      )}
      {(state?.error || error) && (() => {
        const text = String(state?.error || error);
        // 错误只显示一句短的，细节留在日志里——原来整段铺开把下面的设置都挤走了
        const short = text.length > 46 ? `${text.slice(0, 46)}…` : text;
        return (
          <details className="dl-push-error">
            <summary className="dl-error">{short}</summary>
            <p>{text}</p>
          </details>
        );
      })()}

      {logLines.length > 0 && (
        <details className="dl-push-log">
          <summary>ffmpeg 日志（{logLines.length}）</summary>
          <pre>{logLines.slice(-6).join('\n')}</pre>
        </details>
      )}

      <p className="dl-hint">
        一条 ffmpeg 多路输出：选中的平台各推一路，取消选中就停。推流码只存在本机 <code>push.json</code>，界面只显示「已配置」。
        B 站仍建议走上面对话里的官方 OBS 流程。
      </p>
    </div>
  );
}

/**
 * 悬浮采集窗：摄像头 / 屏幕直播 / 画中画，采到的画面直接推给多平台推流。
 *
 * 链路：getUserMedia / getDisplayMedia → canvas 合成（屏幕 + 右下角圆形摄像头）→
 * captureStream + AudioContext 混音 → MediaRecorder(webm, 800ms 一片) → POST /push/feed
 * → 宿主 ffmpeg（-f webm -i pipe:0）转 H.264/AAC → 同时推 N 个平台。
 */

/** 人脸认证：用开播账号的 B 站 App 扫这个码 */
function FaceModal({ qr, onCancel }: { qr: string; onCancel: () => void }) {
  const [img, setImg] = useState('');
  useEffect(() => { void QRCode.toDataURL(qr, { margin: 1, width: 240 }).then(setImg).catch(() => setImg('')); }, [qr]);
  return (
    <div className="dl-modal-wrap">
      <div className="dl-modal">
        <h2>B 站要人脸认证</h2>
        <p>用<b>开播账号</b>登录的 B 站 App 扫这个码，按提示刷脸。认证通过后会自动开播，不用再点。</p>
        {img ? <img className="dl-qr" src={img} alt="人脸认证二维码" /> : <code className="dl-qr-text">{qr}</code>}
        <button className="dl-link" onClick={onCancel}>不开了</button>
      </div>
    </div>
  );
}

function OwnerSay({ onAir }: { onAir: boolean }) {
  const [text, setText] = useState('');
  const [busy, error, run] = useBusy();
  const send = () => run(async () => {
    if (!text.trim()) return;
    await api('owner', { text });
    setText('');
  });
  return (
    <div className="dl-dock-body">
      <div className="dl-row">
        <input value={text} placeholder={onAir ? '比如：给大家讲讲你今天学到的东西' : '开播以后才能跟她说话'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="dl-send" disabled={busy || !onAir || !text.trim()} onClick={send}>说</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

function BroadcastGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
      <path d="M5.2 18.8a9.6 9.6 0 0 1 0-13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
    </svg>
  );
}

function FullscreenGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

/** 醒目留言按金额分档（和舞台一样的 B 站配色） */
function scTier(yuan: number): string {
  if (yuan >= 2000) return 'red';
  if (yuan >= 1000) return 'orange';
  if (yuan >= 500) return 'pink';
  if (yuan >= 100) return 'yellow';
  if (yuan >= 50) return 'cyan';
  return 'blue';
}

/** 头像底色按名字换 */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Feed({ feed, focus, sleep }: { feed: FeedRow[]; focus: Set<string>; sleep: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => feed.filter((r) => r.kind !== 'enter').slice(-80), [feed]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); }, [rows.length]);
  if (!rows.length) {
    return (
      <div className="dl-feed dl-feed-empty">
        <Img className="dl-empty-art" src={sleep} />
        <p>还没有动静。连上直播间，或者在「模拟观众」里发一条试试。</p>
      </div>
    );
  }
  return (
    <div className="dl-feed" ref={ref}>
      {rows.map((r) => {
        const focused = !!r.uid && focus.has(r.uid);
        return (
          <div key={r.key} className={`dl-feed-row dl-k-${r.kind}${focused ? ' dl-focus' : ''}${r.kind === 'superchat' && r.yuan ? ` dl-sc-${scTier(r.yuan)}` : ''}`}>
            {r.kind === 'her'
              ? <span className="dl-feed-avatar dl-her-avatar">鲸</span>
              : <span className="dl-feed-avatar" style={{ '--h': hue(r.name) } as React.CSSProperties}>{[...r.name][0] ?? '?'}</span>}
            <div className="dl-feed-main">
              <span className="dl-feed-name">{r.kind === 'her' ? '她' : r.name}{focused && <em>她在回</em>}{r.yuan ? <b>¥{r.yuan}</b> : null}</span>
              <span className="dl-feed-text">{r.text}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Simulator() {
  const [name, setName] = useState('测试观众');
  const [text, setText] = useState('');
  const [busy, error, run] = useBusy();
  const send = (kind: string, extra: Record<string, unknown> = {}) => run(() => api('simulate', { kind, name, text, ...extra }).then(() => { if (kind === 'chat' || kind === 'superchat') setText(''); }));
  return (
    <div className="dl-dock-body">
      <div className="dl-row">
        <input className="dl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="观众名" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="弹幕内容（醒目留言也用这里的字）" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send('chat'); }} />
        <button className="dl-send" disabled={busy || !text.trim()} onClick={() => send('chat')}>发弹幕</button>
      </div>
      <div className="dl-sim">
        <span>礼物</span>
        <div className="dl-chips">
          <button className="dl-chip-gift" onClick={() => send('gift', { gift: '小花花', count: 5, yuan: 0.5 })}>小花花 ×5</button>
          <button className="dl-chip-gift" onClick={() => send('gift', { gift: '情书', count: 1, yuan: 5.2 })}>情书 ¥5.2</button>
          <button className="dl-chip-gift dl-chip-big" onClick={() => send('gift', { gift: '小电视飞船', count: 1, yuan: 1245 })}>小电视飞船 ¥1245</button>
        </div>
        <span>醒目留言</span>
        <div className="dl-chips">
          {[30, 100, 500, 2000].map((yuan) => (
            <button key={yuan} className={`dl-chip-sc dl-sc-${scTier(yuan)}`} disabled={!text.trim()} title={text.trim() ? '' : '先在上面写留言内容'} onClick={() => send('superchat', { yuan })}>¥{yuan}</button>
          ))}
        </div>
        <span>其他</span>
        <div className="dl-chips">
          <button onClick={() => send('enter')}>进场</button>
          <button onClick={() => send('follow')}>关注</button>
          <button className="dl-chip-guard" onClick={() => send('membership', { guard: 3 })}>上舰</button>
        </div>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

export const CONSOLE_CSS = `
.dl-switch{display:inline-flex;align-items:center;gap:8px;padding:9px 14px !important;border-radius:999px !important;font-size:13px}
.dl-switch i{width:30px;height:17px;border-radius:999px;background:rgba(120,130,150,.35);position:relative;transition:background .2s}
.dl-switch i::after{content:'';position:absolute;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dl-switch.dl-on i{background:#ff5d7a}
.dl-switch.dl-on i::after{transform:translateX(13px)}
.dl-switch.dl-on span{color:#ff5d7a;font-weight:600}
.dl-modal-wrap{position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:rgba(10,14,30,.45);backdrop-filter:blur(6px)}
.dl-modal{width:min(380px,90vw);padding:26px 28px;border-radius:22px;text-align:center;background:#fff;color:#1d2433;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
.dl-modal h2{margin:0 0 8px;font-size:18px}
.dl-modal p{margin:0 0 16px;font-size:13px;line-height:1.7;color:#5b6475}
.dl-qr{width:240px;height:240px;border-radius:12px;background:#fff;padding:8px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.dl-qr-text{display:block;word-break:break-all;font-size:11px;margin-bottom:12px}
/* 颜色跟着 DSH 的亮色 / 暗色走：底色、文字、边框用 DSH 的主题变量，自己只管强调色（light-dark 按 DSH 设在页面上的 color-scheme 取值） */
.dl-room{--dl-blue:#3fa3ff;--dl-pink:#ff7fa8;--dl-gold:light-dark(#c98200,#ffc65c);
  --dl-bg:light-dark(#f4f7fb,var(--dsw-alias-bg-base,#0f131e));
  --dl-surface:light-dark(#ffffff,var(--dsw-alias-bg-layer-1,#161b29));
  --dl-surface-2:light-dark(#eef3fa,var(--dsw-alias-bg-layer-3,#1c2233));
  --dl-sunken:light-dark(#f4f7fb,var(--dsw-alias-bg-base,#0f131e));
  --dl-hover:light-dark(#e2eaf6,#252c41);
  --dl-text:var(--dsw-alias-label-primary,light-dark(#1d2433,#e9eefb));
  --dl-dim:var(--dsw-alias-label-secondary,light-dark(#55607a,rgba(225,232,250,.64)));
  --dl-faint:var(--dsw-alias-label-caption,light-dark(#8a93a8,rgba(225,232,250,.4)));
  --dl-line:var(--dsw-alias-border-l2,light-dark(rgba(0,0,0,.1),rgba(255,255,255,.08)));
  --dl-shadow:0 10px 30px -18px light-dark(rgba(40,70,130,.35),rgba(0,0,0,.6));
  --dl-mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
  position:relative;height:100%;overflow:hidden;color:var(--dl-text);background:var(--dl-bg);
  background-image:radial-gradient(900px 380px at 70% -120px,light-dark(rgba(63,163,255,.12),rgba(92,182,255,.14)),transparent 70%),radial-gradient(700px 320px at 0% 0%,light-dark(rgba(255,127,168,.1),rgba(255,143,182,.08)),transparent 70%)}
.dl-page{height:100%;overflow:auto;padding:22px clamp(18px,3vw,40px) 32px;box-sizing:border-box;display:flex;flex-direction:column;gap:16px}

/* 顶栏：她是谁、现在怎样、开播 */
.dl-top{display:flex;align-items:center;justify-content:space-between;gap:20px}
.dl-brand{display:flex;align-items:center;gap:16px;min-width:0}
.dl-avatar{position:relative;flex:none;display:grid;place-items:center;width:58px;height:58px;border-radius:50%;overflow:hidden;color:#eaf6ff;
  background:linear-gradient(135deg,#bfe3ff,#ffd3e3);box-shadow:0 0 0 3px var(--dl-bg),0 0 0 5px rgba(63,163,255,.55)}
.dl-avatar-img{width:118%;height:118%;object-fit:cover;object-position:50% 12%}
.dl-live .dl-avatar{box-shadow:0 0 0 3px var(--dl-bg),0 0 0 5px #ff5c7c}
.dl-col{display:flex;flex-direction:column;gap:8px}
.dl-live .dl-avatar::after{content:'';position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 2px #ff5c7c;animation:dl-ping 1.8s ease-out infinite}
@keyframes dl-ping{to{transform:scale(1.35);opacity:0}}
.dl-top h1{display:flex;align-items:center;gap:12px;margin:0;font-size:22px;font-weight:750;letter-spacing:1px}
.dl-onair{display:inline-flex;align-items:center;gap:7px;font:700 12px var(--dl-mono);letter-spacing:2px;padding:4px 11px;border-radius:999px;color:#fff;background:#ff4d6d}
.dl-onair i{width:7px;height:7px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
@keyframes dl-rec{0%{box-shadow:0 0 0 0 rgba(255,255,255,.8)}100%{box-shadow:0 0 0 7px rgba(255,255,255,0)}}
.dl-offair{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;color:var(--dl-faint);background:var(--dl-surface-2)}
.dl-pills{display:flex;flex-wrap:wrap;gap:14px;margin-top:7px}
.dl-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dl-dim)}
.dl-top-actions{flex:none;display:flex;align-items:center;gap:10px}
.dl-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--dl-faint)}
.dl-ok{background:#5fe0a8}.dl-warn{background:#ffc65c;animation:dl-blink 1.2s ease-in-out infinite}.dl-bad{background:#ff7a8a}
@keyframes dl-blink{50%{opacity:.4}}

/* 按钮、输入框 */
.dl-room input,.dl-room select{flex:1;min-width:0;padding:10px 12px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-sunken);color:var(--dl-text);font-size:13px;outline:none;transition:border-color .2s,box-shadow .2s}
.dl-room textarea{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-sunken);color:var(--dl-text);font:13px/1.6 inherit;outline:none;resize:vertical}
.dl-pace{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:8px}
.dl-pace label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--dl-dim)}
.dl-pace input{width:64px;text-align:center}
.dl-room textarea:focus{border-color:rgba(63,163,255,.6);box-shadow:0 0 0 3px rgba(63,163,255,.14)}
.dl-room input:focus{border-color:rgba(63,163,255,.6);box-shadow:0 0 0 3px rgba(63,163,255,.14)}
.dl-room input.dl-name{flex:0 0 120px}
.dl-room button{padding:9px 14px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-surface-2);color:var(--dl-text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .2s,border-color .2s,transform .15s}
.dl-room button:hover:not(:disabled){background:var(--dl-hover);border-color:rgba(92,182,255,.4)}
.dl-room button:active:not(:disabled){transform:translateY(1px) scale(.98)}
.dl-room button:disabled{opacity:.4;cursor:default}
.dl-room button.dl-done{color:light-dark(#1f9e68,#5fe0a8);border-color:rgba(95,224,168,.5)}
.dl-room button.dl-send{min-width:64px;color:#fff;font-weight:700;background:var(--dl-blue);border-color:transparent}
.dl-room button.dl-send:hover:not(:disabled){background:#62b5ff}
.dl-room .dl-icon-btn{display:inline-flex;align-items:center;gap:7px;color:var(--dl-dim);background:transparent}
.dl-btn{display:inline-flex;align-items:center;gap:9px;font-size:15px !important;font-weight:750;letter-spacing:1px;padding:11px 26px !important;border-radius:999px !important}
.dl-room .dl-primary{color:#fff;background:linear-gradient(100deg,#ff6b8f,#ff8fb6);border-color:transparent;box-shadow:0 8px 24px -8px rgba(255,107,143,.8)}
.dl-room .dl-primary:hover:not(:disabled){background:linear-gradient(100deg,#ff7d9c,#ffa0c2);border-color:transparent}
.dl-go-dot{width:9px;height:9px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
.dl-room .dl-danger{color:light-dark(#d42d52,#ffd9e0);background:rgba(255,77,109,.14);border-color:rgba(255,120,140,.45)}

/* 开播前准备 */
.dl-checklist{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px;border-radius:16px;background:linear-gradient(100deg,rgba(63,163,255,.1),rgba(255,127,168,.08));border:1px solid rgba(63,163,255,.2)}
.dl-checklist>b{font-size:13px;margin-right:6px}
.dl-checklist>b em{font-style:normal;color:var(--dl-blue);font-family:var(--dl-mono);margin-left:4px}
.dl-room button.dl-step{display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;border-radius:999px;background:var(--dl-surface)}
.dl-step i{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;font-style:normal;font-size:12px;border:1.5px dashed var(--dl-faint)}
.dl-step small{font-size:11px;color:var(--dl-faint)}
.dl-step-done{opacity:.7}
.dl-step-done i{border:0;background:#5fe0a8;color:#08261a;font-weight:800}

/* 主区：左边监视器 + 导播台，右边直播间 */
.dl-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:16px}
@media (max-width:1100px){.dl-grid{grid-template-columns:1fr}.dl-side{min-height:520px}}
.dl-main{display:flex;flex-direction:column;gap:16px;min-width:0}
.dl-label{font-size:12px;color:var(--dl-faint);letter-spacing:1px;white-space:nowrap}
.dl-meta{font-size:12px;color:var(--dl-faint)}

.dl-monitor{border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:var(--dl-shadow);overflow:hidden}
.dl-preview{position:relative;aspect-ratio:16/9;background:#05070c}
.dl-preview iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dl-preview:fullscreen{aspect-ratio:auto;width:100vw;height:100vh;background:#000}
.dl-room .dl-fullscreen{position:absolute;right:12px;top:12px;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;
  color:#fff;background:rgba(10,14,24,.6);border-color:rgba(255,255,255,.18);backdrop-filter:blur(6px);opacity:.75}
.dl-room .dl-fullscreen:hover:not(:disabled){opacity:1;background:rgba(10,14,24,.8)}
.dl-preview:fullscreen .dl-fullscreen,.dl-preview:fullscreen .dl-preview-tag{display:none}
.dl-preview-tag{position:absolute;left:12px;top:12px;display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;color:#fff;background:rgba(10,14,24,.6);backdrop-filter:blur(6px);pointer-events:none}
.dl-preview-tag i{width:6px;height:6px;border-radius:50%;background:var(--dl-faint)}
.dl-preview-live i{background:#ff4d6d;animation:dl-rec 1.6s ease-out infinite}
.dl-monitor-bar{padding:12px 16px;border-top:1px solid var(--dl-line)}
.dl-obs{display:flex;align-items:center;gap:10px;min-width:0}
.dl-obs code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--dl-mono);color:var(--dl-dim);padding:8px 12px;border-radius:10px;background:var(--dl-sunken);cursor:pointer}
.dl-skins{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px 14px;padding:4px 16px 16px}
.dl-skin-list{display:flex;flex-wrap:wrap;gap:10px}
.dl-room button.dl-skin{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:6px 6px 8px;border-radius:14px;background:var(--dl-sunken)}
.dl-skin-img{display:block;width:150px;aspect-ratio:16/9;border-radius:9px;object-fit:cover}
.dl-skin-blank{background:linear-gradient(135deg,#2a3350,#3a2f4f)}
.dl-skin b{font-size:12px;font-weight:600;padding:0 4px}
.dl-skin small{font-size:10px;color:var(--dl-faint);padding:0 4px;margin-top:-4px}
.dl-room button.dl-skin.dl-on{border-color:var(--dl-blue);box-shadow:0 0 0 1px var(--dl-blue)}
.dl-skin.dl-on b{color:var(--dl-blue)}

.dl-dock{border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:var(--dl-shadow)}
.dl-tabs{display:flex;align-items:center;gap:4px;padding:10px 12px 0}
.dl-room .dl-tabs button{border:0;background:transparent;color:var(--dl-dim);font-weight:600;border-radius:10px 10px 0 0;padding:9px 14px}
.dl-room .dl-tabs button.dl-on{color:var(--dl-text);background:var(--dl-surface-2);box-shadow:inset 0 -2px 0 var(--dl-blue)}
.dl-tabs .dl-meta{margin-left:auto;padding-right:6px}
.dl-dock-body{padding:14px 16px 16px;border-top:1px solid var(--dl-line)}
.dl-row{display:flex;gap:10px;align-items:center}
.dl-sim{display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:center;margin-top:14px}
.dl-sim>span{font-size:12px;color:var(--dl-faint)}
.dl-chips{display:flex;flex-wrap:wrap;gap:8px}
.dl-chips button{font-size:12px !important;padding:6px 13px !important;border-radius:999px !important}
.dl-room .dl-chips button.dl-on{border-color:var(--dl-blue);color:var(--dl-blue)}
.dl-room .dl-chips .dl-chip-gift{color:light-dark(#9a6200,#ffe1a6);border-color:rgba(255,190,80,.45);background:rgba(255,198,92,.1)}
.dl-room .dl-chips .dl-chip-big{color:#2a1b02;font-weight:700;border-color:transparent;background:linear-gradient(90deg,#ffe1a6,#ffb547)}
.dl-room .dl-chips .dl-chip-sc{color:#fff;font-weight:700;border-color:transparent;background:var(--sc)}
.dl-room .dl-chips .dl-chip-guard{color:#fff;border-color:transparent;background:linear-gradient(90deg,#3d8bff,#a58bff)}
.dl-sc-blue{--sc:#2a7bd8}.dl-sc-cyan{--sc:#19a8bd}.dl-sc-yellow{--sc:#d39a17}.dl-sc-pink{--sc:#e0609f}.dl-sc-orange{--sc:#ef7a2a}.dl-sc-red{--sc:#e0393f}

/* 右栏：直播间，像观众看到的弹幕栏 */
.dl-side{display:flex;flex-direction:column;min-height:0;border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:var(--dl-shadow);overflow:hidden}
.dl-side-head{padding:14px 16px 12px;border-bottom:1px solid var(--dl-line)}
.dl-now{display:flex;align-items:center;gap:9px;font-size:14px}
.dl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:12px}
.dl-stats div{padding:8px 4px;border-radius:12px;background:var(--dl-sunken);text-align:center}
.dl-stats b{display:block;font-size:17px;font-weight:750;font-family:var(--dl-mono)}
.dl-stats span{font-size:10px;color:var(--dl-faint)}
.dl-stats .dl-hot b{color:var(--dl-gold)}
.dl-feed{flex:1;min-height:260px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px 14px 10px}
.dl-feed::-webkit-scrollbar{width:6px}.dl-feed::-webkit-scrollbar-thumb{background:var(--dl-line);border-radius:3px}
.dl-feed-empty{align-items:center;justify-content:center;text-align:center}
.dl-feed-empty p{margin:0;font-size:12px;color:var(--dl-faint);max-width:220px;line-height:1.6}
.dl-empty-art{width:150px;opacity:.9}
.dl-feed-row{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.5;animation:dl-row-in .3s ease-out}
@keyframes dl-row-in{from{opacity:0;transform:translateY(6px)}}
.dl-feed-avatar{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font-size:12px;font-weight:700;color:#fff;
  background:linear-gradient(135deg,hsl(var(--h,200) 70% 62%),hsl(calc(var(--h,200) + 40) 70% 55%))}
.dl-her-avatar{background:linear-gradient(135deg,var(--dl-blue),var(--dl-pink))}
.dl-feed-main{display:flex;flex-direction:column;align-items:flex-start;min-width:0;flex:1}
.dl-feed-name{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dl-faint);max-width:100%;white-space:nowrap;overflow:hidden}
.dl-feed-name em{font-style:normal;font-size:10px;font-weight:700;padding:0 7px;border-radius:999px;color:#fff;background:var(--dl-blue)}
.dl-feed-name b{color:var(--dl-gold);font-family:var(--dl-mono)}
.dl-feed-text{max-width:100%;box-sizing:border-box;padding:6px 11px;border-radius:4px 14px 14px 14px;background:var(--dl-surface-2);word-break:break-word}
.dl-k-her{flex-direction:row-reverse}
.dl-k-her .dl-feed-main{align-items:flex-end}
.dl-k-her .dl-feed-text{border-radius:14px 4px 14px 14px;color:#06121f;background:linear-gradient(120deg,#9fd5ff,#ffc4da)}
.dl-k-gift .dl-feed-text,.dl-k-membership .dl-feed-text{color:light-dark(#8a5800,#ffe1a6);background:rgba(255,198,92,.16)}
.dl-k-superchat .dl-feed-text{color:#fff;background:var(--sc,#2a7bd8)}
.dl-k-follow .dl-feed-text{color:light-dark(#c8457a,#ffc4da);background:rgba(255,143,182,.12)}
.dl-focus .dl-feed-text{box-shadow:0 0 0 2px var(--dl-blue)}
.dl-links{display:flex;gap:16px;padding:10px 16px 14px;border-top:1px solid var(--dl-line)}
.dl-room .dl-link{background:none;border:none;color:var(--dl-blue);padding:2px 0;font-size:12px}

/* 设置抽屉 */
.dl-drawer-wrap{position:absolute;inset:0;z-index:20;background:light-dark(rgba(30,40,60,.25),rgba(5,8,14,.5));backdrop-filter:blur(2px);animation:dl-fade .2s ease-out}
@keyframes dl-fade{from{opacity:0}}
.dl-drawer{position:absolute;top:0;right:0;bottom:0;width:min(440px,92%);overflow:auto;box-sizing:border-box;padding:20px 22px 30px;background:var(--dl-surface);border-left:1px solid var(--dl-line);box-shadow:-20px 0 50px -20px light-dark(rgba(40,60,100,.3),rgba(0,0,0,.6));animation:dl-slide .25s cubic-bezier(.2,.8,.2,1)}
@keyframes dl-slide{from{transform:translateX(40px);opacity:0}}
.dl-drawer>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.dl-drawer h2{margin:0;font-size:17px}
.dl-drawer h3{margin:22px 0 4px;font-size:12px;font-weight:600;color:var(--dl-faint);letter-spacing:1px}
.dl-field{display:flex;flex-direction:column;gap:7px;margin-top:10px;min-width:0}
.dl-field label{font-size:12px;color:var(--dl-dim);display:flex;align-items:center;gap:8px}
.dl-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dl-dim);margin:8px 0 2px}
.dl-check input{flex:none}
.dl-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dl-line);color:var(--dl-faint)}
.dl-ok-tag{color:light-dark(#1f9e68,#5fe0a8);border-color:rgba(95,224,168,.45)}
.dl-hint{margin:0;font-size:12px;color:var(--dl-faint);line-height:1.6}
.dl-error{margin:6px 0 0;font-size:12px;color:light-dark(#d43a4f,#ffb4b4)}
.dl-banner{margin:0;padding:10px 14px;border-radius:12px;background:rgba(255,90,120,.1);border:1px solid rgba(255,120,140,.35)}

/* 悬浮采集窗（摄像头 / 屏幕直播 / 画中画） */
.dl-dockwin{position:absolute;z-index:15;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;
  background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:0 20px 44px -20px rgba(10,20,40,.5)}
.dl-dockwin.dl-min{height:auto !important}
.dl-dockwin-head{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;cursor:move;
  background:linear-gradient(180deg,rgba(120,170,255,.18),rgba(120,170,255,.04));border-bottom:1px solid var(--dl-line)}
.dl-dockwin-head b{font-weight:700;letter-spacing:.2px}
.dl-dockwin-head .dl-dot{margin-right:2px}
.dl-dockwin-body{position:relative;flex:1;min-height:120px;background:#000;display:flex;align-items:center;justify-content:center}
.dl-dockwin-body canvas{max-width:100%;max-height:100%;display:block}
.dl-dockwin-body .dl-meta{position:absolute;left:8px;bottom:6px;color:#fff;opacity:.85}
.dl-dockwin-foot{display:flex;gap:6px;flex-wrap:wrap;padding:6px 8px}
.dl-dockwin-foot button{font-size:12px;padding:4px 10px}
.dl-dockwin-grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--dl-line) 50%)}
.dl-dockwin-note{padding:8px 10px;border-top:1px solid var(--dl-line);background:var(--dl-sunken)}
.dl-dockwin-note p{margin:0 0 6px;font-size:11.5px;line-height:1.55;color:var(--dl-dim)}

/* ── B 站手动推流码（绕过 60043）───────────────────────────── */
.dl-manual-push summary{cursor:pointer;font-size:12px;color:var(--dl-dim);padding:4px 0;list-style:none}
.dl-manual-push summary::-webkit-details-marker{display:none}
.dl-manual-push[open] summary{color:var(--dl-text);font-weight:600}

/* 60043 报错下面那排补救按钮 */
.dl-banner-fix{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-radius:10px;
  border:1px dashed var(--dl-line);background:var(--dl-sunken)}
.dl-banner-fix .dl-meta{flex:1;min-width:160px}

/* 开播前自检结果 */
.dl-preflight{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:10px;
  border:1px solid var(--dl-line);background:var(--dl-sunken)}
.dl-preflight.dl-ok{border-color:color-mix(in srgb,var(--dl-pink) 55%,var(--dl-line))}
.dl-preflight b{font-size:13px;color:var(--dl-text)}
.dl-preflight ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.dl-preflight li{display:flex;gap:7px;align-items:baseline;font-size:12px;line-height:1.5}
.dl-preflight-label{font-weight:600;color:var(--dl-text);white-space:nowrap}
.dl-preflight-detail{color:var(--dl-dim);word-break:break-word}

/* ── 多平台推流面板 ───────────────────────────────────────── */.dl-push{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dl-line);border-radius:14px;
  background:var(--dl-surface);box-shadow:var(--dl-shadow)}
.dl-push-head{display:flex;gap:8px;align-items:center}
.dl-push-head select{flex:1}
.dl-seg{display:inline-flex;padding:2px;border-radius:10px;background:var(--dl-sunken);border:1px solid var(--dl-line)}
.dl-seg button{border:0;background:transparent;color:var(--dl-dim);font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer}
.dl-seg button.dl-on{background:var(--dl-blue);color:#fff;font-weight:600;box-shadow:0 2px 8px -2px var(--dl-blue)}
.dl-push-note{margin:0;font-size:12px;color:var(--dl-faint);line-height:1.5}
.dl-push-warn{padding:6px 9px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dl-gold) 45%,var(--dl-line));
  background:color-mix(in srgb,var(--dl-gold) 10%,transparent);color:var(--dl-gold)}
.dl-push-region{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.dl-push-region label{display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--dl-line);
  border-radius:10px;background:var(--dl-sunken);font-size:11.5px;color:var(--dl-faint)}
.dl-push-region label span{flex:none;width:2.2em;text-align:center}
.dl-push-region input{flex:1;min-width:0;border:0;background:transparent;padding:0;text-align:right;
  font-variant-numeric:tabular-nums;font-weight:600}
/* 折叠外层：默认收起，展开后跟卡片一样占满宽度 */
.dl-push-wrap{border:1px solid var(--dl-line);border-radius:14px;background:var(--dl-surface);overflow:hidden}
.dl-push-wrap>summary{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 14px;cursor:pointer;
  list-style:none;border-bottom:1px solid transparent}
.dl-push-wrap>summary::-webkit-details-marker{display:none}
.dl-push-wrap>summary::before{content:'▸ ';color:var(--dl-faint)}
.dl-push-wrap[open]>summary{border-bottom-color:var(--dl-line)}
.dl-push-wrap[open]>summary::before{content:'▾ '}
.dl-push-wrap .dl-push{border:0;border-radius:0;box-shadow:none;background:transparent}
.dl-push-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.dl-push-metrics label{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--dl-line);border-radius:10px;background:var(--dl-sunken)}
.dl-push-metrics label span{font-size:11px;color:var(--dl-faint);flex:none}
.dl-push-metrics label input{flex:1;min-width:0;border:0;background:transparent;padding:0;font-variant-numeric:tabular-nums;font-weight:600}
.dl-push-metrics label em{font-style:normal;font-size:10px;color:var(--dl-faint)}
.dl-push-engine{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dl-push-engine-name{font-size:12px;color:var(--dl-dim);font-family:var(--dl-mono);white-space:nowrap}
/* 「安装」和路径输入：窄屏时整行折下去，不再挤成“安装 或” */
.dl-push-engine input{flex:1 1 220px;min-width:0}
.dl-push-engine button{flex:none}
.dl-push-error{margin:0}
.dl-push-error summary{cursor:pointer;font-size:12px;list-style:none}
.dl-push-error summary::-webkit-details-marker{display:none}
.dl-push-error p{margin:4px 0 0;font-size:11.5px;line-height:1.55;color:var(--dl-dim)}
.dl-push-platforms{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.dl-push-plat{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 9px;border-radius:10px;
  border:1px solid var(--dl-line);background:var(--dl-sunken);cursor:pointer;text-align:left}
.dl-push-plat:hover{background:var(--dl-hover)}
.dl-push-plat.dl-on{border-color:var(--dl-blue);background:color-mix(in srgb,var(--dl-blue) 16%,var(--dl-surface))}
/* 正在下面编辑的那个平台：加一圈虚线，跟“已选中推流”区分开 */
.dl-push-plat.dl-editing{outline:1px dashed var(--dl-blue);outline-offset:-3px}
.dl-push-plat-name{font-size:12.5px;font-weight:600;color:var(--dl-text)}
.dl-push-plat-state{font-size:10.5px;color:var(--dl-faint);white-space:nowrap}
.dl-push-plat-state.dl-warn{color:var(--dl-gold)}
.dl-push-plat-state.dl-ok{color:var(--dl-pink)}
.dl-push-card{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:12px;border:1px dashed var(--dl-line);background:var(--dl-sunken)}
.dl-push-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dl-push-card label{font-size:11px;color:var(--dl-faint)}
.dl-push-card-foot{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.dl-push-card-foot .dl-hint{margin:0;flex:1;min-width:160px}
.dl-push-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dl-push-actions .dl-primary{font-weight:700}
.dl-push-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dl-dim);margin-left:auto}
.dl-push-status.dl-live{color:var(--dl-pink);font-weight:600}
.dl-push-log summary{cursor:pointer;font-size:11.5px;color:var(--dl-faint)}
.dl-push-log pre{margin:6px 0 0;padding:8px;border-radius:8px;background:var(--dl-sunken);border:1px solid var(--dl-line);
  font-family:var(--dl-mono);font-size:11px;line-height:1.5;max-height:120px;overflow:auto;white-space:pre-wrap;color:var(--dl-dim)}
`;
