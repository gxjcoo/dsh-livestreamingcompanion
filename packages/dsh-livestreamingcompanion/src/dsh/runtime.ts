/**
 * 插件的共享状态：宿主根插件（index.ts）和 agent 子插件（agent.ts）用同一份（同一个进程，同一个模块实例）。
 *
 *   - show：这一场直播的身体
 *   - server：舞台服务器（OBS 打开的那个地址）
 *   - settings：房间号、角色、模板……存在 DSH_HOME/dsh-livestreamingcompanion/settings.json（控制台里改）
 *   - 机密（B 站 Cookie、豆包密钥）不在这里：走 DSH 的凭据服务，按名字取
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveShow, type LiveSnapshot } from '../body/show';
import { Whisper } from '../body/asr';
import { BiliAccount } from '../body/biliAccount';
import { BiliVideos } from '../body/biliVideo';
import { DouyinVideos, type DouyinCheck } from '../body/douyinVideo';
import { BrowserBridge } from '../core/platforms/douyin/douyinBridge';
import { BiliSocial } from '../body/biliSocial';
import { VideoLibrary } from '../body/videoLibrary';
import { SocialManager } from '../body/social';
import { Broadcast } from '../body/broadcast';
import { Push } from '../body/push';
import { Relay } from '../body/relay';
import { DmManager } from '../body/dm';
import { Packs } from '../body/packs';
import { StageServer } from '../body/server';
import { canSpeak, subtitleTimeline, synthesize, type TtsAuth } from '../body/tts';
import { DEFAULT_VOICE } from '../body/voices';
import type { DistillLlm } from '../core/memory/distill';
import type { CharacterManifest, GameSource } from '../stage/protocol';
import { gameRect } from '../stage/layout';
import { connectObs, showGameSources } from '../body/obs';
import { normalizePushServer } from '../core/push/platforms';
import type { OwnerPace } from '../core/attention/attention';

export interface Settings {
  /** 连哪个直播平台：B 站（默认）或抖音 */
  platform: 'bilibili' | 'douyin';
  /** B 站房间号 */
  roomId: number | null;
  /** 抖音直播间：live.douyin.com 后面那串数字（web_rid） */
  douyinRoom: number | null;
  /** 抖音弹幕要借浏览器连：Chrome/Edge 的可执行文件；空着自动找 */
  douyinBrowser: string;
  /** B 站 播着的时候，也把抖音直播间的弹幕一起收（抖音那边同时开着才需要） */
  douyinAlsoListen: boolean;
  character: string;
  template: string;
  /** 舞台是否显示终端聊天框（她说、工具调用等） */
  showTerminal: boolean;
  /** 空串用角色包的默认音色 */
  voice: string;
  stagePort: number;
  stageToken: string;
  /** 下播提炼观众记忆用的模型（provider/model） */
  distillModel: string;
  /** 没话题多少秒后自己找话说 */
  idleAfterSec: number;
  /** 话痨模式：直播间没人在看的时候也接着说（默认开：她平常话太少；嫌费钱在控制台关掉） */
  talkWhenAlone: boolean;
  /** 她在玩游戏时，弹幕至少隔多少秒推给她一次（越大回得越少、玩得越多） */
  gameChatGapSec: number;
  /** 主人说是自己的直播间（记住常来的观众）；别的房间只旁观、不建档 */
  ownRooms: number[];
  /** 抖音那边自己的直播间（同样的意思） */
  ownDouyinRooms: number[];
  /** 开播时真的推流到 B 站（默认关：只在本地彩排） */
  broadcast: boolean;
  /** 开播用的分区（子分区 id）；null 用 B 站给账号准备的默认分区 */
  areaId: number | null;
  /** 开播前改成这个标题；空串不改 */
  liveTitle: string;
  /** 推流协议：srt（B 站给了就用，跨境、丢包的网络上比 rtmp 稳）或 rtmp */
  pushProtocol: 'srt' | 'rtmp';
  /** 推流码率（kbps） */
  streamKbps: number;
  /** 手动推流地址（直播姬 → 第三方推流）；和下面那个一起填就绕过 B 站开播接口（60043 风控时用） */
  manualPushAddr: string;
  /** 手动推流码 */
  manualPushCode: string;
  /** 直播间封面图片的路径（本机文件）；空串不换 */
  liveCover: string;
  /** 装了 faster-whisper 的 Python（视频没字幕时听写用）；空串不听写 */
  asrPython: string;
  /** whisper 模型：large-v3-turbo（有显卡）、small（只有 CPU）…… */
  asrModel: string;
  /** 语音合成走后端：豆包云（默认，带逐字时间）或本地 GPT-SoVITS（自训音色） */
  ttsBackend: 'doubao' | 'gptsovits';
  /** 本地 GPT-SoVITS api_v2.py 的地址 */
  gptsovitsUrl: string;
  /** 参考音频（3~10 秒干净人声） */
  gptsovitsRef: string;
  /** 参考音频对应文本 */
  gptsovitsPrompt: string;
  /** 告示板：主人想让观众知道的。空行分页，每页第一行是标题；空串不显示告示板 */
  boardText: string;
  /** 滚动通知：画面最底下一条滚动的字，出状况时告诉观众（卡了、在修、马上回来）；空串不显示 */
  noticeText: string;
  /** 主人定的节奏（秒）：没填的项按直播间热度自动；欢迎填 off 就不欢迎新观众 */
  pace: Pace;
}

export interface Pace {
  welcomeSec?: number | 'off';
  thanksSec?: number;
  followSec?: number;
  chatPicks?: number;
}

/** 控制台填的节奏 → 注意力层用的（毫秒） */
function ownerPace(p: Pace | undefined): OwnerPace {
  if (!p) return {};
  return {
    ...(p.welcomeSec === 'off' ? { welcomeOff: true } : p.welcomeSec !== undefined ? { welcomeGapMs: p.welcomeSec * 1000 } : {}),
    ...(p.thanksSec !== undefined ? { thanksGapMs: p.thanksSec * 1000 } : {}),
    ...(p.followSec !== undefined ? { followGapMs: p.followSec * 1000 } : {}),
    ...(p.chatPicks !== undefined ? { chatPicks: p.chatPicks } : {}),
  };
}

/** 告示板默认写的：观众怎么跟她玩 */
export const DEFAULT_BOARD = [
  '想看什么，跟大肥鱼说',
  '说个大概：「想看猫猫」',
  '她自己去抖音搜、挑来放',
  '找错了告诉她，她再找',
  '',
  '还可以这样玩',
  '让她「看看我的主页」',
  '常来的观众她会记住',
  '她靠字幕听，也会看一眼画面',
  '',
  '大肥鱼是怎么玩游戏的',
  '她自己看游戏画面、想好下一步',
  '下指令给游戏里的身体去做',
  '边玩边回弹幕，没人替她玩',
].join('\n');

/** 旧版默认告示板：只在用户没自定义过时跟着改成抖音，别覆盖主人自己写的文案 */
const LEGACY_DEFAULT_BOARD = DEFAULT_BOARD.replace('她自己去抖音搜、挑来放', '她自己去 B 站搜、挑来放');

/** 机密的名字（DSH 凭据）。豆包的和 dsh-game 共用 */
export const SECRETS = {
  cookie: 'BILIBILI_COOKIE',
  /** 抖音 Cookie（可选：只读观众名字用；不填也能连直播间，只是名字会打码） */
  douyinCookie: 'DOUYIN_COOKIE',
  ttsApiKey: 'DOUBAO_TTS_API_KEY',
  ttsAppId: 'DOUBAO_TTS_APP_ID',
  ttsAccessKey: 'DOUBAO_TTS_ACCESS_KEY',
} as const;

export const PRESET_ID = 'dsh-livestreamingcompanion';

/**
 * 用户数据目录：<DSH_HOME>/dsh-livestreamingcompanion
 * 插件从 dsh-livestream 改名时搬过一次；如果新目录还没有（比如老机器第一次升级），
 * 就退回老目录继续用，别让 settings / 观众记忆读空。
 */
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
export const dataDir = (() => {
  const next = join(home, 'dsh-livestreamingcompanion');
  const old = join(home, 'dsh-livestream');
  if (existsSync(join(next, 'settings.json'))) return next;
  if (existsSync(join(old, 'settings.json'))) return old;
  return next;
})();

/** 插件包目录（构建产物在 lib/ 或 lib/chunks/，往上找 package.json） */
export function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name === 'dsh-livestreamingcompanion') return dir;
    dir = dirname(dir);
  }
  throw new Error('dsh-livestreamingcompanion: 找不到插件包目录');
}

const SETTINGS_FILE = join(dataDir, 'settings.json');

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
  } catch {
    // 第一次用
  }
  const settings: Settings = {
    platform: 'bilibili',
    roomId: null,
    douyinRoom: null,
    douyinBrowser: '',
    douyinAlsoListen: false,
    character: 'dafeiyu',
    template: 'default',
    showTerminal: true,
    voice: '',
    stagePort: 7390,
    stageToken: '',
    distillModel: 'deepseek-official/deepseek-flash',
    idleAfterSec: 45,
    talkWhenAlone: true,
    gameChatGapSec: 15,
    ownRooms: [],
    ownDouyinRooms: [],
    broadcast: false,
    areaId: null,
    liveTitle: '',
    pushProtocol: 'srt',
    streamKbps: 4500,
    manualPushAddr: '',
    manualPushCode: '',
    liveCover: '',
    asrPython: '',
    asrModel: 'large-v3-turbo',
    ttsBackend: 'doubao',
    gptsovitsUrl: 'http://127.0.0.1:9880',
    gptsovitsRef: '',
    gptsovitsPrompt: '',
    boardText: DEFAULT_BOARD,
    noticeText: '',
    pace: {},
    ...saved,
  };
  let dirty = false;
  if (saved.boardText === LEGACY_DEFAULT_BOARD) {
    settings.boardText = DEFAULT_BOARD;
    dirty = true;
  }
  if (!settings.stageToken) {
    settings.stageToken = randomBytes(12).toString('base64url');
    dirty = true;
  }
  if (dirty) saveSettings(settings);
  return settings;
}

function saveSettings(next: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

export const settings: Settings = loadSettings();

export function updateSettings(patch: Partial<Settings>): Settings {
  Object.assign(settings, patch);
  saveSettings(settings);
  return settings;
}

/** agent 子插件接上 DSH 的服务后填这里：读机密、调模型 */
export const hooks: {
  secret: (name: string) => Promise<string>;
  /** 存一个机密（扫码登录拿到的 Cookie）；没有凭据服务时抛错 */
  setSecret: (name: string, value: string) => Promise<void>;
  push: (sessionId: string, text: string, now?: boolean) => Promise<boolean>;
  complete: ((model: string, system: string, user: string) => Promise<string>) | null;
  log: (level: 'info' | 'warn', message: string) => void;
} = {
  secret: async (name) => process.env[name] ?? '',
  setSecret: async () => { throw new Error('这个 DSH 没有凭据服务，存不了'); },
  push: async () => false,
  complete: null,
  log: (level, message) => (level === 'warn' ? console.warn : console.log)(`[dsh-livestreamingcompanion] ${message}`),
};

async function ttsAuth(voice: string): Promise<TtsAuth | null> {
  // 本地 GPT-SoVITS：不需要豆包密钥，只要地址和参考音频
  if (settings.ttsBackend === 'gptsovits') {
    const local = {
      url: settings.gptsovitsUrl.trim(),
      refAudio: settings.gptsovitsRef.trim(),
      promptText: settings.gptsovitsPrompt.trim() || '什么嘛，这么简单的事情，你居然专门跑来问我。',
    };
    const auth = { local };
    return canSpeak(auth, voice) ? auth : null;
  }
  const [apiKey, appId, accessKey] = await Promise.all([hooks.secret(SECRETS.ttsApiKey), hooks.secret(SECRETS.ttsAppId), hooks.secret(SECRETS.ttsAccessKey)]);
  const auth = { apiKey, appId, accessKey };
  return canSpeak(auth, voice) ? auth : null;
}

export const packs = new Packs(packageDir(), dataDir);

export function currentCharacter(): CharacterManifest | null {
  return packs.character(settings.character);
}

export function currentVoice(): string {
  return settings.voice || currentCharacter()?.voice || DEFAULT_VOICE;
}

/** 她能用的表情：角色包里有的 */
export function currentMoods(): string[] {
  const c = currentCharacter();
  const moods = c?.clips?.moods ?? c?.image?.moods ?? {};
  return ['talk', ...Object.keys(moods)];
}

const distill: DistillLlm = async (system, user) => {
  if (!hooks.complete) throw new Error('DSH 的模型服务还没接上');
  return hooks.complete(settings.distillModel, system, user);
};

export const show = new LiveShow(
  {
    push: (sessionId, text, now) => hooks.push(sessionId, text, now),
    synthesize: (text, signal, voice) => {
      if (voice) return speech(text, signal, voice);
      const ready = prepared.get(`${currentVoice()}|${text}`);
      if (ready) {
        prepared.delete(`${currentVoice()}|${text}`);
        return ready.catch(() => speech(text, signal));
      }
      return speech(text, signal);
    },
    distill,
    log: (level, message) => hooks.log(level, message),
    persist: (snapshot) => saveLive(snapshot),
    onGame: (source) => placeGame(source),
  },
  { dataDir, names: currentCharacter()?.names ?? [], idleAfterMs: () => settings.idleAfterSec * 1000, soloTalk: () => settings.talkWhenAlone, pace: () => ownerPace(settings.pace), board: () => settings.boardText, gameChatGapMs: () => (settings.gameChatGapSec ?? 15) * 1000 },
);

/**
 * 游戏画面上 OBS：窗口画面（Minecraft 摄像机客户端）由 OBS 抓，摆在舞台的游戏位上、垫在舞台下面；
 * 网页画面舞台自己放，OBS 里不用加东西。连不上 OBS（没开、只在本机预览）就算了
 */
export function placeGame(source: GameSource | null): void {
  const template = packs.template(settings.template);
  const windowSource = source && 'window' in source ? source : null;
  void (async () => {
    let obs: Awaited<ReturnType<typeof connectObs>> | null = null;
    try {
      obs = await connectObs(false);
      await showGameSources(obs, windowSource, template ? gameRect(template) : { x: 0, y: 0, w: 1920, h: 1080 });
      hooks.log('info', windowSource ? `游戏画面上舞台：${windowSource.window}` : '游戏画面撤下');
    } catch (err) {
      hooks.log('warn', `游戏画面没能放进 OBS：${(err as Error).message}`);
    } finally {
      obs?.close();
    }
  })();
}

/** 告示板换了：舞台马上换（之后连上的舞台页也拿到最新的） */
export function publishBoard(): void {
  show.stage.broadcast({ type: 'board', text: settings.boardText });
}
publishBoard();

/** 滚动通知换了：舞台马上换 */
export function publishNotice(): void {
  show.stage.broadcast({ type: 'notice', text: settings.noticeText ?? '' });
}
publishNotice();

async function speech(text: string, signal: AbortSignal, voice = currentVoice()): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null> {
  const auth = await ttsAuth(voice);
  if (!auth) return null;
  const { audio, words } = await synthesize(auth, voice, text, signal);
  return { audio, timeline: subtitleTimeline(text, words) };
}

/** 提前合成好的句子（念稿时先合成、念的时候直接用，句和句之间不空等）：音色|文字 → 语音 */
const prepared = new Map<string, Promise<Awaited<ReturnType<typeof speech>>>>();

/** 提前合成一句（text 是 speakable 处理过的那段）；最多留 40 句，用掉就删 */
export function prepareSpeech(text: string): void {
  const key = `${currentVoice()}|${text}`;
  if (!text || prepared.has(key)) return;
  prepared.set(key, speech(text, AbortSignal.timeout(60_000)));
  while (prepared.size > 40) prepared.delete(prepared.keys().next().value!);
}

export const server = new StageServer({
  port: settings.stagePort,
  token: settings.stageToken,
  packageDir: packageDir(),
  packs,
  stage: show.stage,
  current: () => ({ character: settings.character, template: settings.template, showTerminal: settings.showTerminal }),
  media: {
    source: (id) => show.player.source(id),
    report: (id, state, positionSec, detail) => show.player.report(id, state, positionSec, detail),
  },
  // /capture 页面（在真浏览器里开，权限正常）采到的分片 → 多平台推流的 ffmpeg
  feed: (chunk) => push.feed(chunk),
  log: (level, message) => hooks.log(level, message),
});

export async function cookie(): Promise<string> {
  return hooks.secret(SECRETS.cookie);
}

/** 抖音那边的 Cookie（可选；只是让观众名字别打码） */
export async function douyinCookie(): Promise<string> {
  return hooks.secret(SECRETS.douyinCookie);
}

/**
 * 用看得见的浏览器登录抖音：主人扫码/短信登录，登完把整条 Cookie 存进 DSH 凭据。
 * 抖音的搜索只对登录用户开放，这一步是把搜索打开的关键；存之前会用接口验一遍。
 */
export async function douyinLogin(): Promise<{ cookie: string; check: DouyinCheck }> {
  const bridge = new BrowserBridge({ browserPath: settings.douyinBrowser.trim() || undefined });
  try {
    const cookie = await bridge.login();
    // 存之前先验：抖音接口说「没登录」就不算登录成功（页面看着像登上了也不算）
    const check = await douyinVideos.verify(cookie);
    if (check.api === 'login' || check.api === 'none') {
      throw new Error(`浏览器里看着登录了，但抖音接口仍判未登录（${check.message}）。窗口里再扫码一次，或者换个账号。`);
    }
    await hooks.setSecret(SECRETS.douyinCookie, cookie);
    return { cookie, check };
  } finally {
    bridge.stop();
  }
}

/** 现在这台机器上要连的房间号（按当前平台取） */
export function currentRoom(): number | null {
  return settings.platform === 'douyin' ? settings.douyinRoom : settings.roomId;
}

/** 现在这个平台下「是不是自己的直播间」 */
export function isOwnRoom(roomId: number): boolean {
  return (settings.platform === 'douyin' ? settings.ownDouyinRooms : settings.ownRooms).includes(roomId);
}

/** 连直播间用的 Cookie（按平台） */
export async function currentCookie(): Promise<string> {
  return settings.platform === 'douyin' ? douyinCookie() : cookie();
}

/** 推流到 B 站：开播拿推流码、OBS 推流、下播 */
export const broadcast = new Broadcast({
  cookie,
  stageUrl: () => server.url,
  areaId: () => settings.areaId,
  title: () => settings.liveTitle.trim() || null,
  protocol: () => settings.pushProtocol,
  kbps: () => settings.streamKbps,
  // 填了手动推流码就用它，跳过 B 站开播接口（60043 风控时的救急通道）
  manualStream: () => {
    // 直播姬复制出来的地址可能是 rtmpsrt://…，OBS 不认（会报 Unknown protocol!），统一还原成 rtmp://
    const addr = normalizePushServer(settings.manualPushAddr);
    const code = settings.manualPushCode.trim();
    if (!addr || !code) return null;
    return { addr, code, protocol: addr.startsWith('srt://') ? 'srt' : 'rtmp' };
  },
  cover: () => {
    const file = settings.liveCover.trim();
    if (!file || !existsSync(file)) return null;
    const ext = extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { data: new Uint8Array(readFileSync(file)), mime };
  },
  // 开播账号的直播间：记下来、标成自己的直播间（记住观众），连上它的弹幕
  onRoom: (roomId) => {
    updateSettings({ roomId, ownRooms: [...new Set([...settings.ownRooms, roomId])] });
    const status = show.status();
    if (status.roomId !== roomId || status.live.state === 'idle' || status.live.state === 'error') {
      void cookie().then((c) => show.connect(roomId, c, true));
    } else {
      show.rememberViewers = true;
    }
  },
  onStreaming: () => show.markBroadcast(),
  log: (level, message) => hooks.log(level, message),
});

/** 她给观众发私信（开播账号）：B 站「对方没关注只能发一条」等规矩在这里管 */
export const dm = new DmManager(new BiliAccount(cookie), join(dataDir, 'dm.json'));

// ── 断点续播：在播的这一场存在磁盘上，插件（DSH）重启后接着播 ──

const LIVE_FILE = join(dataDir, 'live.json');

function saveLive(snapshot: LiveSnapshot | null): void {
  try {
    if (!snapshot) rmSync(LIVE_FILE, { force: true });
    else writeFileSync(LIVE_FILE, JSON.stringify({ ...snapshot, broadcasting: broadcast.streaming }));
  } catch (err) {
    hooks.log('warn', `存不了直播状态：${(err as Error).message}`);
  }
}

/** 上次停下时还在播的那一场（没有返回 null）；读了就删，接上以后会重新存 */
/** agent 子插件（她的会话）起来、装好推消息的钩子了没有 */
let agentAttached = false;
export const agentReady = (): boolean => agentAttached;
export function markAgentReady(): void {
  agentAttached = true;
}

export function takeLive(): (LiveSnapshot & { broadcasting: boolean }) | null {
  try {
    const saved = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as LiveSnapshot & { broadcasting: boolean };
    rmSync(LIVE_FILE, { force: true });
    return saved?.sessionId ? saved : null;
  } catch {
    return null;
  }
}

/** 她点赞、看评论、发评论、看收件箱（开播账号） */
export const social = new SocialManager(new BiliSocial(cookie));

/** 直播时每隔一会儿看一眼收件箱：开播以后新来的私信、回复、@，没别的事时告诉她 */
const INBOX_EVERY_MS = 90_000;
setInterval(() => {
  if (!show.isOnAir) return;
  void social.newSince().then((lines) => { if (lines.length) show.notifyInbox(lines); }).catch(() => {});
}, INBOX_EVERY_MS).unref?.();

/** 她搜视频、看视频、在舞台上放视频（开播账号的 Cookie：AI 字幕要登录才给） */
export const videos = new BiliVideos(cookie);

/** 视频没字幕时听写（本机的 faster-whisper） */
export const asr = new Whisper({
  python: () => settings.asrPython,
  model: () => settings.asrModel.trim() || 'large-v3-turbo',
  script: join(packageDir(), 'assets', 'asr', 'whisper_worker.py'),
  dataDir,
  log: (level, message) => hooks.log(level, message),
});

/** 视频库：她看过、放过的视频（详情、字幕、原视频弹幕、每次看的记录），存在 <dataDir>/videos */
export const library = new VideoLibrary(join(dataDir, 'videos'), (message) => hooks.log('warn', message));

/**
 * 多平台并行推流：一条 ffmpeg 命令多路输出，把同一份画面同时推到抖音/快手/视频号/虎牙…
 * 和各家的推流码一起存在 <dataDir>/push.json（不进 settings.json，避免被设置接口整包覆盖）
 */
export const push = new Push(join(dataDir, 'push.json'));

/**
 * 本地 RTMP 中继（MediaMTX）：多平台推流里「自定义」的落点，能推能拉，方便端到端验收。
 * 插件只管起停和状态；二进制放在 ~/dsh-relay/ 或 <dataDir>/relay/ 都行。
 */
export const relay = new Relay(dataDir, 1935);

/** 抖音视频：按链接/id 看详情、拿播放地址（借浏览器截页面自己的接口响应） */
export const douyinVideos = new DouyinVideos(
  () => new BrowserBridge({ browserPath: settings.douyinBrowser.trim() || undefined }),
  douyinCookie,
);
