/**
 * agent 子插件：挂在「大肥鱼直播」预设下（见 cordis.patch.yml），接上 DSH 的服务，盯着她直播的会话。
 *
 * 只有一个说话出口：她回复的正文。会话里每出现一条带正文的 assistant 消息就念一条（写出一段念一段），
 * 每条只念一次。正文里的 [表情] 标记（角色包里有的）把话切成几段，每段带着自己的表情念：说着说着可以换表情。
 * 只发工具调用、没写正文的消息很正常（她在做事），没有要念的就跳过。
 * 没有说话工具、没有 say 参数：那种「要模型自己选择用的通道」在 HiyoriAI 和 dsh-game 里都踩过坑（她会不用）。
 *
 * 身体往会话里推一件事：DSH 的 agent 句柄 followup（追加一条消息并唤醒她）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { fetchProfile, profileSummary, profileText } from '../body/biliProfile';
import { clock, type VideoInfo, type VideoPart } from '../body/biliVideo';
import { lookupProblem } from '../core/viewerLookup';
import { splitByMood } from '../core/moodText';
import { ttsYuan, turnYuan } from '../core/cost';
import { cookie, currentMoods, dm, douyinVideos, hooks, markAgentReady, settings, show, social, videos } from './runtime';
import { douyinSearchText, douyinVideoText, resolveDouyinShare } from '../body/douyinVideo';
import { HANDOFF_PREFIX } from '../body/show';
import { BiliRoom } from '../body/biliRoom';
import { screenshot } from '../body/obs';
import { whoIs } from '../body/biliLogin';
import { COMMENT_GAP_MS, FAVORITE_FOLDER, MAX_COMMENT_CHARS } from '../body/social';

export const name = 'dsh-livestreamingcompanion-agent';
export const inject = ['tools'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  get?(name: string): any;
  [service: string]: any;
}

/** 已经念过的消息：会话 id + 消息序号 */
const voiced = new Set<string>();

const wordsOf = (event: any): string => (event?.data?.message?.content ?? [])
  .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
  .map((p: any) => p.text.trim()).filter(Boolean).join('\n');

/**
 * 盯着直播的会话：新的正文就念，一轮开始、结束告诉身体。
 * 有游戏线时两个会话一起盯：游戏线的话也念（嘴里排满了就少念一句），它的时刻里摘出游戏现在怎样，写给直播线
 */
const cursors = new Map<string, number>();
let watching = false;
/** 这场直播（她的会话，有游戏线时两个加起来）累计用掉的 token 和钱：舞台上换算成她吃了多少饭，show_stats 告诉她 */
const freshUsage = (sessionId: string) => ({ sessionId, tokens: 0, input: 0, cacheRead: 0, output: 0, yuan: 0, priced: true, model: '' });
let usage = freshUsage('');
/** 游戏线最近一个时刻里的进度、身体、背包，和她在游戏线上最近说的一句 */
let gameMoment = '';
let gameWords = '';
/** 游戏线刚收到交接（game_side）：它接下来那一条回复不念（直播线已经回过观众了，那条多半是「收到」「记下了」） */
let hushNext = false;

function countUsage(sessionId: string, event: any, broadcast = true): void {
  const u = event?.data?.usage;
  const turn = Number(u?.totalTokens);
  if (!Number.isFinite(turn) || turn <= 0) return;
  if (usage.sessionId !== sessionId) usage = freshUsage(sessionId);
  usage.tokens += turn;
  usage.input += Number(u.inputTokens) || 0;
  usage.cacheRead += Number(u.cacheReadTokens) || 0;
  usage.output += Number(u.outputTokens) || 0;
  const model = event?.data?.message?.source?.model;
  if (typeof model === 'string') usage.model = model;
  const yuan = turnYuan(model, u, Number(event?.time) || Date.now());
  if (yuan === null) usage.priced = false; else usage.yuan += yuan;
  if (broadcast) show.stage.broadcast({ type: 'usage', tokens: usage.tokens, turn, ...(typeof model === 'string' ? { model } : {}) });
}

/** dsh-game 的时刻里摘出直播线要知道的：进度（位置、白天黑夜、血量饥饿）、身体在干什么、背包 */
export function momentSummary(text: string): string {
  const pick = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? '';
  const progress = pick(/【进度】([^\n]+)/);
  if (!progress) return '';
  const body = pick(/【说明】(身体[^\n]+)/);
  const bag = pick(/【说明】背包：([^\n]+)/);
  // 背包整行给（以前截到 120 字，背包一满，钻石剑这些排在后面的就被截掉，她当着观众说「没有钻石剑」）
  return [progress, body, bag && `背包：${bag}`].filter(Boolean).join('；');
}

function publishGameNow(moment = false): void {
  show.setGameNow([gameMoment, gameWords && `你刚在游戏里说：「${gameWords}」`].filter(Boolean).join('；'), moment);
}

function watchSession(ctx: AgentContext, sessionId: string, line: 'live' | 'game'): void {
  const session = ctx.get?.('sessions')?.get?.(sessionId);
  if (!session) return;
  const total = show.currentSession ?? sessionId;
  // 刚开始盯这个会话：只管从现在起的新事件；用量从头补算（插件重启后接着播时，饭量不清零）
  if (!cursors.has(sessionId)) {
    cursors.set(sessionId, Number(session.seq));
    if (line === 'live') usage = freshUsage(sessionId);
    for (const event of (session.snapshotEvents(0) as any[]) ?? []) if (event?.type === 'assistant/message') countUsage(total, event, false);
    if (usage.tokens) show.stage.broadcast({ type: 'usage', tokens: usage.tokens, turn: 0, ...(usage.model ? { model: usage.model } : {}) });
    return;
  }
  const events = session.snapshotEvents(cursors.get(sessionId)) as any[];
  cursors.set(sessionId, Number(session.seq));
  for (const event of events) {
    if (event?.type === 'turn/start') show.turnStarted(sessionId);
    else if (event?.type === 'turn/end') show.turnEnded(sessionId);
    else if (event?.type === 'user/message' && line === 'game') {
      const said = (event?.data?.content ?? []).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
      if (said.startsWith(HANDOFF_PREFIX)) hushNext = true;
    } else if (event?.type === 'tool/result' && line === 'game') {
      const summary = momentSummary(wordsOf(event));
      if (summary) {
        gameMoment = summary;
        publishGameNow(true);
      }
    } else if (event?.type === 'assistant/message') {
      countUsage(total, event);
      const key = `${sessionId}:${event.seq}`;
      if (voiced.has(key)) continue;
      voiced.add(key);
      const words = wordsOf(event);
      if (!words) continue;
      if (line === 'game') {
        // 交接后的回执：同一件事直播线刚说过，这条不念（里面的游戏动作照常做）
        if (hushNext) {
          hushNext = false;
          show.unsaid(words, '交接后的回执');
          continue;
        }
        gameWords = words.replace(/\[[a-z]+\]/g, '').trim().slice(0, 80);
        publishGameNow();
      }
      // 交给嘴排队念（嘴一次念一句，按交来的先后），不在这里等念完：
      // 「这一轮结束了」要马上让导演知道，导演自己看嘴里还排着几句再决定推不推下一件
      for (const part of splitByMood(words, currentMoods())) {
        void show.say(part.text, part.mood, AbortSignal.timeout(300_000), line).catch((err) => hooks.log('warn', `念她的话出错：${(err as Error).message}`));
      }
    }
  }
}

async function watch(ctx: AgentContext): Promise<void> {
  const sessionId = show.currentSession;
  if (!sessionId || watching) return;
  watching = true;
  try {
    // 换了一场（另一个会话）：游戏线的摘要也清掉
    if (!cursors.has(sessionId)) {
      cursors.clear();
      gameMoment = '';
      gameWords = '';
      hushNext = false;
    }
    watchSession(ctx, sessionId, 'live');
    const game = show.currentGameSession;
    if (game && game !== sessionId) watchSession(ctx, game, 'game');
  } finally {
    watching = false;
  }
}

/**
 * 往她的会话里推一条消息并唤醒她；会话不在线返回 false。
 * 平时用 followup（排到下一轮：她这一轮做完再看）；now 用 steer（插进这一轮的下一步：
 * 她在玩游戏时一轮可以很长，用 followup 的话直播间的事要等她这一轮停下才看得到）
 */
async function push(ctx: AgentContext, sessionId: string, text: string, now = false): Promise<boolean> {
  const agents = ctx.get?.('agents');
  const found = agents?.get?.(sessionId);
  const agent = found?.followup ? found : found?.agent;
  if (!agent?.followup) return false;
  // 和 DSH 自己的 createUserMessage 一样：带 id、role，冻结（消息进会话后不能再改）
  const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-livestreamingcompanion' } });
  if (now && agent.steer) await agent.steer(message);
  else await agent.followup(message);
  return true;
}

/** 钱数写给她看：不到一分钱就说不到一分钱 */
function money(yuan: number): string {
  return yuan < 0.01 ? '不到 1 分钱' : `${yuan.toFixed(2)} 元`;
}

/** 视频没给时长时，不指定就放这么久（秒） */
const PLAY_UNKNOWN_SEC = 600;
/** 播放工具最多等舞台多久确认开始放 */
const PLAY_CONFIRM_MS = 15_000;

/** 「1:30」「90」→ 秒 */
function seconds(value: unknown): number {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (!text) return 0;
  return Math.max(0, text.split(':').reduce((sum, n) => sum * 60 + (Number(n) || 0), 0));
}

/** 她说的一个人：私信过她的人、直播间里的观众（名字或 UID），或者任何 UID；认不出时返回告诉她怎么改的话 */
function person(who: string): { uid: string; name: string } | string {
  const w = who.trim();
  const talker = social.findTalker(w);
  if (talker) return talker;
  const viewer = show.lookupViewer(w);
  if (viewer.kind === 'found') return { uid: viewer.uid, name: viewer.user.name };
  if (/^\d{1,20}$/.test(w)) return { uid: w, name: `UID ${w}` };
  return lookupProblem(w, viewer);
}

/** 她给的视频（BV 号、av 号、链接）和第几 P → 视频详情；认不出、找不到时返回告诉她怎么改的话 */
async function findVideo(video: unknown, part: unknown): Promise<{ info: VideoInfo; part: VideoPart } | string> {
  const text = String(video ?? '').trim();
  const ref = await videos.resolve(text);
  if (!ref) return `没认出「${text.slice(0, 40)}」是哪个视频：video 填 BV 号（BV 开头的 12 位，view_profile 的投稿里有）、av 号或者视频链接。`;
  const info = await videos.info(ref);
  if (!info) return `${ref.bvid ?? `av${ref.aid}`} 打不开：可能没有这个视频、被删了，或者 B 站没返回（网络问题）。检查一下号码。`;
  const page = Math.floor(Number(part) || ref.part || 1);
  const found = info.parts.find((p) => p.page === page);
  if (!found) return `「${info.title}」只有 ${info.parts.length} P，没有 P${page}。`;
  return { info, part: found };
}

/** 调一次模型（下播提炼记忆）：不思考，只要文字 */
async function completeWithDsh(ctx: AgentContext, model: string, system: string, user: string): Promise<string> {
  const llm = ctx.get?.('llm');
  if (!llm) throw new Error('DSH 的模型服务不可用');
  const slash = model.indexOf('/');
  let out = '';
  for await (const chunk of llm.stream({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    system,
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-livestreamingcompanion' } }],
    maxTokens: 3000,
    reasoningEffort: 'off',
    purpose: 'dsh-livestreamingcompanion-memory',
    signal: AbortSignal.timeout(120_000),
  })) {
    if (chunk.type === 'text-delta') out += chunk.text;
  }
  return out.trim();
}

export function apply(ctx: AgentContext): void {
  hooks.secret = async (name) => {
    const credentials = ctx.get?.('credentials');
    const hit = credentials ? await credentials.resolve(name).catch(() => undefined) : undefined;
    return hit?.value ?? process.env[name] ?? '';
  };
  hooks.setSecret = async (name, value) => {
    const credentials = ctx.get?.('credentials');
    if (!credentials?.set) throw new Error('这个 DSH 没有凭据服务，存不了');
    await credentials.set(name, value);
  };
  hooks.complete = (model, system, user) => completeWithDsh(ctx, model, system, user);
  hooks.push = (sessionId, text, now) => push(ctx, sessionId, text, now);
  markAgentReady();
  // 警告也打到 stderr：DSH 网页版的日志只在内存里，服务器上看 web.log 才找得到
  if (ctx.logger) hooks.log = (level, message) => {
    ctx.logger[level]?.(`dsh-livestreamingcompanion: ${message}`);
    if (level === 'warn') console.warn(`[dsh-livestreamingcompanion] ${message}`);
  };

  ctx.effect(() => {
    const timer = setInterval(() => void watch(ctx).catch((err) => hooks.log('warn', `盯会话出错：${(err as Error).message}`)), 300);
    return () => clearInterval(timer);
  }, 'dsh-livestreamingcompanion session watch');

  // 看观众的 B 站主页（公开信息）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'view_profile',
    description: '看一个 B 站个人主页：等级、签名、粉丝和关注数、最近投稿、置顶视频、代表作、空间公告、有没有直播间。'
      + '可以看观众的，也可以看你自己开播账号的。只看得到主页上公开的东西。要几秒钟。',
    parameters: {
      who: { type: 'string', required: true, description: '观众的名字（照消息里写的）或 UID；看你自己开播账号的主页填「自己」' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '');
      if (who.trim() === '自己') {
        const me = await whoIs(await cookie());
        if (!me) return '开播账号现在没登录，看不了自己的主页。';
        show.toolCall('view_profile', me.name, '在看自己的主页');
        const profile = await fetchProfile(String(me.uid), await cookie());
        return profile ? `你自己的开播账号（${me.name}，UID ${me.uid}）：
${profileText(profile)}` : '没打开自己的主页（B 站没返回，可能是网络问题）。';
      }
      const viewer = show.lookupViewer(who);
      if (viewer.kind !== 'found') return lookupProblem(who, viewer);
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} 说过不想被记住，他的主页就不看了。`;
      show.toolCall('view_profile', viewer.how === 'unseen-uid' ? `UID ${viewer.uid}` : viewer.user.name, viewer.how === 'unseen-uid' ? `在看 UID ${viewer.uid} 的主页` : `在看${viewer.user.name}的主页`);
      const profile = await fetchProfile(viewer.uid, await cookie());
      if (!profile) return viewer.how === 'unseen-uid' ? `UID ${viewer.uid} 打不开：可能没有这个用户，检查一下数字。` : `没打开 ${viewer.user.name} 的主页（B 站没返回，可能是网络问题）。`;
      const marks = [
        viewer.user.guardLevel ? ['', '总督', '提督', '舰长'][viewer.user.guardLevel] : '',
        viewer.user.medal?.ofThisRoom ? `粉丝牌${viewer.user.medal.level}级` : '',
        viewer.user.isAdmin ? '房管' : '',
      ].filter(Boolean).join('，');
      show.rememberProfile(viewer.uid, profileSummary(profile));
      // 按名字的一部分找到的：告诉她是谁，对不上可以换 UID 再查
      const note = viewer.how === 'partial' ? `（按「${who}」找到的是 ${profile.name}；不是他的话，用 UID 再查）\n` : '';
      return note + profileText(profile, marks || undefined);
    },
  })), 'view_profile tool');

  // 私信观众（开播账号发）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'send_dm',
    description: '用开播账号给一个人发一条 B 站私信（文字）：直播间里的观众、私信过你的人，或者任何 B 站用户（填 UID）。'
      + 'B 站规定：对方没关注开播账号、也没回过私信时，只能发一条，要等他关注或回复才能再发；结果里会告诉你他关注了没有。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（照消息里写的）或 UID' },
      text: { type: 'string', required: true, description: '私信内容（2000 字节以内）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      if (show.optedOut(who.uid)) return `${who.name} 说过不想被记住，就不私信他了。`;
      show.toolCall('send_dm', `→ ${who.name}`, `在给${who.name}发私信`);
      const result = await dm.send(who, String(args.text ?? ''));
      if (result.ok) show.noteDm(who.name, String(args.text ?? ''));
      return result.text;
    },
  })), 'send_dm tool');

  // 点赞：视频或者一条评论
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'like',
    description: '用开播账号点赞：给一个 B 站视频（video），或者给一条评论（comment，read_comments / check_inbox 里方括号的编号）。',
    parameters: {
      video: { type: 'string', description: 'BV 号、av 号或视频链接' },
      comment: { type: 'string', description: '评论编号' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const comment = String(args.comment ?? '').trim();
      if (comment) {
        show.toolCall('like', `评论 ${comment}`, '在给评论点赞');
        return social.likeComment(comment);
      }
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      show.toolCall('like', `「${found.info.title.slice(0, 16)}」`, '在点赞');
      return social.likeVideo(found.info.aid, found.info.title);
    },
  })), 'like tool');

  // 看评论区
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_comments',
    description: '看一个 B 站视频的评论区：每条带编号（回复、点赞用）、名字、点赞数、楼里的几条回复。可以按热门或最新，可以翻页。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      sort: { type: 'string', enum: ['hot', 'new'], description: 'hot 热门（默认）、new 最新' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      const { info } = found;
      show.toolCall('read_comments', `「${info.title.slice(0, 16)}」`, `在看「${info.title.slice(0, 16)}」的评论区`);
      return social.readComments({ type: 1, oid: String(info.aid), title: info.title }, args.sort === 'new' ? 'new' : 'hot', Math.max(1, Math.floor(Number(args.page) || 1)));
    },
  })), 'read_comments tool');

  // 发评论
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'post_comment',
    description: '用开播账号发一条 B 站评论：发在视频下面（video），或者回复某一条评论（reply_to，read_comments / check_inbox 里方括号的编号）。'
      + `评论公开挂在那里，大家都看得到是这个账号发的。两条之间隔 ${COMMENT_GAP_MS / 1000} 秒（发太快 B 站会风控）。`,
    parameters: {
      text: { type: 'string', required: true, description: `评论内容（${MAX_COMMENT_CHARS} 字以内）` },
      video: { type: 'string', description: '发在哪个视频下面：BV 号、av 号或视频链接' },
      reply_to: { type: 'string', description: '回复哪一条评论：评论编号' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const replyTo = String(args.reply_to ?? '').trim() || undefined;
      let thread = null;
      if (!replyTo) {
        const found = await findVideo(args.video, undefined);
        if (typeof found === 'string') return found;
        thread = { type: 1, oid: String(found.info.aid), title: found.info.title };
      }
      show.toolCall('post_comment', replyTo ? `回复 ${replyTo}` : `「${thread!.title.slice(0, 16)}」`, '在发评论');
      const result = await social.postComment(thread, String(args.text ?? ''), replyTo);
      if (result.ok) show.noteComment(String(args.text ?? ''), thread?.title ?? replyTo ?? '');
      return result.text;
    },
  })), 'post_comment tool');

  // 收件箱
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'check_inbox',
    description: '看开播账号的收件箱：最近的私信会话（谁、未读几条、最后一句），和别人在评论区回复你、@ 你的。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('check_inbox', '', '在看私信和评论回复');
      return social.inbox();
    },
  })), 'check_inbox tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_dm',
    description: '看你和一个人最近的私信往来（他说了什么、你回了什么）。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（check_inbox 里的）或 UID' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '').trim();
      const talker = social.findTalker(who) ?? (/^\d{1,20}$/.test(who) ? { uid: who, name: `UID ${who}` } : null);
      if (!talker) {
        const viewer = show.lookupViewer(who);
        if (viewer.kind !== 'found') return `不知道「${who}」是谁：先 check_inbox 看看私信列表，用那里的名字或 UID。`;
        show.toolCall('read_dm', viewer.user.name, `在看和${viewer.user.name}的私信`);
        return social.conversation(viewer.uid, viewer.user.name);
      }
      show.toolCall('read_dm', talker.name, `在看和${talker.name}的私信`);
      return social.conversation(talker.uid, talker.name);
    },
  })), 'read_dm tool');

  const text = (value: string) => [{ type: 'text' as const, text: value }];
  const stringOut = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => text(value) };

  // 看一眼直播画面：OBS 截一张观众看到的画面，作为图片给她（DSH 存进附件，下一步她就能看）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'look',
    description: '看一眼直播画面：截一张观众现在看到的直播画面给你。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          text: { type: 'string' as const, required: true },
          image: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' as const, required: true },
              mediaType: { type: 'string' as const, required: true },
              bytes: { type: 'integer' as const, required: true },
              width: { type: 'integer' as const, required: true },
              height: { type: 'integer' as const, required: true },
              name: { type: 'string' as const },
            },
          },
        },
      },
      render: (_args: unknown, value: { text: string; image?: Record<string, unknown> }) => [
        { type: 'text' as const, text: value.text },
        ...(value.image ? [{ type: 'image' as const, attachment: value.image as never }] : []),
      ],
    },
    async execute(_args, exec: any) {
      show.toolCall('look', '', '在看直播画面');
      const attachments = ctx.get?.('attachments');
      const llm = ctx.get?.('llm');
      const routed = exec?.agent?.session?.requestHeader?.()?.config;
      const provider = routed?.provider ?? exec?.agent?.options?.provider;
      const model = routed?.model ?? exec?.agent?.options?.model;
      const info = llm && provider && model ? await llm.resolveModelInfo(provider, model, exec?.signal).catch(() => null) : null;
      if (!attachments || !info?.inputModalities?.includes('image')) return { text: '现在用的模型不能看图，这次看不了画面。' };
      let data: Uint8Array;
      try {
        data = await screenshot();
      } catch (err) {
        hooks.log('warn', `look 截图失败：${(err as Error).message}`);
        return { text: '画面没截到（直播电脑上的 OBS 没连上），过一会儿再看。' };
      }
      const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: 'look.jpg' });
      const at = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19);
      return {
        text: `直播画面，${at}：`,
        image: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) },
      };
    },
  })), 'look tool');

  // 这场的数据：播了多久、用了多少 token、大概花了多少钱
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'show_stats',
    description: '看这场直播的数据：播了多久、你用了多少 token、大概花了多少钱（模型和配音）、念了多少字。',
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall('show_stats', '', '在看这场的账');
      const s = show.stats();
      const tts = ttsYuan(s.spokenChars);
      const minutes = Math.round(s.liveMs / 60_000);
      const lines = [
        `这场播了 ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`}。`,
        `你用了 ${usage.tokens.toLocaleString('en-US')} token（缓存命中 ${usage.cacheRead.toLocaleString('en-US')}，没命中的输入 ${usage.input.toLocaleString('en-US')}，输出 ${usage.output.toLocaleString('en-US')}）。`,
        usage.priced
          ? `模型大概花了 ${money(usage.yuan)}（缓存命中很便宜；工作日白天高峰价，其余时间半价）。`
          : '这个模型的价钱这里不知道，只能报 token。',
        `念了大约 ${s.spokenChars} 个字，配音大概 ${money(tts)}（3 元一万字）。`,
      ];
      return lines.join('\n');
    },
  })), 'show_stats tool');

  // 关注、取关
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'follow',
    description: '用开播账号关注一个人（比如回关新粉丝），或者取关。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（直播间里、私信里的）或 UID' },
      unfollow: { type: 'boolean', description: 'true 是取关，默认关注' },
    },
    output: stringOut,
    async execute(args) {
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      const follow = args.unfollow !== true;
      show.toolCall('follow', `${follow ? '' : '取关 '}${who.name}`, follow ? `在关注${who.name}` : `在取关${who.name}`);
      return social.follow(who.uid, who.name, follow);
    },
  })), 'follow tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'my_fans',
    description: '看开播账号最新的粉丝：谁、什么时候关注的、你回关了没有。',
    parameters: { page: { type: 'number', description: '第几页，默认 1' } },
    output: stringOut,
    async execute(args) {
      show.toolCall('my_fans', '', '在看新粉丝');
      return social.fans(Math.max(1, Math.floor(Number(args.page) || 1)));
    },
  })), 'my_fans tool');

  // 删评论（自己发的，或者自己视频下面别人的）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'delete_comment',
    description: '删掉一条评论：你自己发的（post_comment 给的编号），或者开播账号自己视频下面别人的（read_comments / check_inbox 里的编号）。',
    parameters: { comment: { type: 'string', required: true, description: '评论编号' } },
    output: stringOut,
    async execute(args) {
      const rpid = String(args.comment ?? '').trim();
      show.toolCall('delete_comment', rpid, '在删评论');
      return social.deleteComment(rpid);
    },
  })), 'delete_comment tool');

  // 发动态
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'post_dynamic',
    description: '用开播账号发一条 B 站文字动态（标注为 AI 生成），关注这个账号的人首页都看得到。',
    parameters: { text: { type: 'string', required: true, description: '动态内容' } },
    output: stringOut,
    async execute(args) {
      show.toolCall('post_dynamic', String(args.text ?? '').slice(0, 16), '在发动态');
      const result = await social.postDynamic(String(args.text ?? ''));
      if (result.ok) show.noteDynamic(String(args.text ?? ''));
      return result.text;
    },
  })), 'post_dynamic tool');

  // 收藏、投币
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'favorite',
    description: `把一个 B 站视频收进你自己的收藏夹「${FAVORITE_FOLDER}」（开播账号上，主人原有的收藏夹不动）。`,
    parameters: { video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' } },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      show.toolCall('favorite', `「${found.info.title.slice(0, 16)}」`, '在收藏');
      return social.favorite(found.info.aid, found.info.title);
    },
  })), 'favorite tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coin',
    description: '用开播账号给一个 B 站视频投币（1 个或 2 个，一个视频最多投 2 个），可以顺便点赞。硬币是账号自己的。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      count: { type: 'number', description: '投几个：1 或 2，默认 1' },
      like: { type: 'boolean', description: '顺便点赞，默认 true' },
    },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      const count = Number(args.count) === 2 ? 2 : 1;
      show.toolCall('coin', `「${found.info.title.slice(0, 16)}」×${count}`, '在投币');
      return social.coin(found.info.aid, found.info.title, count, args.like !== false);
    },
  })), 'coin tool');

  // 直播间：禁言、解禁、改标题
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mute',
    description: '在你的直播间禁言一个人（这段时间他发不了弹幕）。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（弹幕里的）或 UID' },
      hours: { type: 'number', description: '禁言多少小时，默认 1' },
    },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      const hours = Math.max(1, Math.min(720, Math.floor(Number(args.hours) || 1)));
      show.toolCall('mute', `${who.name} ${hours}h`, `在禁言${who.name}`);
      return social.mute(roomId, who.uid, who.name, hours);
    },
  })), 'mute tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'unmute',
    description: '解开直播间里一个人的禁言（名字或 UID）；名字对不上时会列出现在被禁言的人。',
    parameters: { who: { type: 'string', required: true, description: '名字或 UID' } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      show.toolCall('unmute', String(args.who ?? ''), '在解禁言');
      return social.unmute(roomId, String(args.who ?? ''));
    },
  })), 'unmute tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'set_live_title',
    description: '改你直播间的标题（40 字以内），推荐页和搜索里显示的就是它。',
    parameters: { title: { type: 'string', required: true, description: '新标题' } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      const title = String(args.title ?? '').trim().slice(0, 40);
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      if (!title) return '标题是空的。';
      show.toolCall('set_live_title', title.slice(0, 16), '在改直播间标题');
      try {
        await new BiliRoom(await cookie()).update(roomId, { title });
        return `直播间标题改成了「${title}」。`;
      } catch (err) {
        return `改标题没成功：${(err as Error).message}`;
      }
    },
  })), 'set_live_title tool');

  // 冲突要求交给观众决定：工具等待 10 秒计票，唯一胜选项随结果交回这一轮执行
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'start_vote',
    description: '一位或多位观众同时提出互相冲突、不能一起做的要求时，发起 10 秒弹幕投票。'
      + '右上角显示编号选项，观众发 1、2、3……投票，每人一票、可以改票。'
      + '工具会等计票结束并返回结果：有唯一胜选项时必须接着只执行它；平票或无人投票时不要执行。'
      + '不要用于普通聊天、互不冲突的要求或主人的明确指令。',
    parameters: {
      question: { type: 'string', required: true, description: '请大家决定什么，60 字以内，比如「接下来做什么？」' },
      options: { type: 'array', required: true, items: { type: 'string' }, description: '2–6 个互相冲突的具体做法，每个 40 字以内，不要只写人名' },
    },
    output: stringOut,
    async execute(args) {
      const question = String(args.question ?? '').trim();
      const options = Array.isArray(args.options) ? args.options.map((option) => String(option)) : [];
      show.toolCall('start_vote', question.slice(0, 30), '在等弹幕投票（10 秒）');
      return show.startVote(question, options);
    },
  })), 'start_vote tool');

  // 视频点播只开放抖音工具：不要在这里注册 B 站搜索 / 观看 / 播放工具，
  // 否则模型即使收到「只用抖音」的提示，仍可能自行选择 B 站。

  // 搜抖音视频
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'douyin_search',
    description: '默认的视频搜索工具。观众只说「刷视频」「看个视频」「想看……」而未指定平台时，必须用这个工具搜抖音。'
      + '返回一页候选（19 位视频 id、标题、作者、时长、点赞、发布日期），可以按最新（newest）或最多点赞（likes）排，可以翻页。'
      + '挑中的 id 直接给 douyin_video 或 play_douyin_video。抖音搜索只对登录用户开放：没配 Cookie 时说明需要登录，不要退回 B 站。',
    parameters: {
      query: { type: 'string', required: true, description: '搜什么，几个字就够' },
      order: { type: 'string', description: 'relevance（默认）/ newest（最新）/ likes（最多点赞）' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) return '搜什么？给个关键词。';
      const order = args.order === 'newest' || args.order === 'likes' ? args.order : 'relevance';
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      show.toolCall('douyin_search', `「${query}」`, `在搜抖音视频：${query}`);
      const result = await douyinVideos.search(query, { page, order });
      return douyinSearchText(query, result, { page, order });
    },
  })), 'douyin_search tool');

  // 抖音视频：看一条（详情 + 有没有字幕）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'douyin_video',
    description: '看一条抖音视频（默认的视频详情工具；观众发来的链接、分享口令、或者抖音视频号都可以）：返回标题、作者、时长、点赞评论、话题。'
      + '抖音网页端不给播放量。这条视频作者上传了官方字幕的话也会告诉你。',
    parameters: {
      video: { type: 'string', required: true, description: '抖音视频链接（v.douyin.com 短链也行）或 19 位视频 id' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const id = await resolveDouyinShare(String(args.video ?? ''));
      if (!id) return `没认出「${String(args.video ?? '').slice(0, 40)}」是哪条抖音视频：把观众发的链接整条填进来（v.douyin.com/… 那种也行），或者填 19 位视频 id。`;
      show.toolCall('douyin_video', `抖音 ${id.slice(-6)}`);
      const info = await douyinVideos.info(id);
      if (!info) return `这条抖音视频打不开：可能被删了、私密，或者抖音这次没给数据（换个时间再试）。`;
      return douyinVideoText(info);
    },
  })), 'douyin_video tool');

  // 在舞台上放抖音视频
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'play_douyin_video',
    description: '默认的视频播放工具：在直播间的舞台上放一条抖音视频；未指定平台的视频点播必须用它。'
      + '舞台换成看视频的布局，放完换回来。默认从头放到结尾，可以只放一段。放的时候你照常说话，你说话时视频声音会自动调小。',
    parameters: {
      video: { type: 'string', required: true, description: '抖音视频链接（v.douyin.com 短链也行）或 19 位视频 id' },
      from: { type: 'string', description: '从哪里开始放：秒数或「分:秒」，默认 0' },
      seconds: { type: 'number', description: '放多少秒，不填就放到结尾' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const id = await resolveDouyinShare(String(args.video ?? ''));
      if (!id) return '没认出这是哪条抖音视频：把链接整条填进来（v.douyin.com 短链也行）或者填 19 位视频 id。';
      show.toolCall('play_douyin_video', `抖音 ${id.slice(-6)}`);
      const info = await douyinVideos.info(id);
      if (!info) return '这条抖音视频打不开：可能被删了、私密，或者这次没拿到数据。';
      if (!info.playUrl) return `「${info.title}」没拿到能放的地址（抖音这次没给），换一条吧。`;
      const from = Math.floor(seconds(args.from));
      if (info.durationSec && from >= info.durationSec) return `「${info.title}」一共只有 ${clock(info.durationSec)}，从 ${clock(from)} 开始就没有了。`;
      const asked = Number(args.seconds) > 0 ? Math.max(5, Number(args.seconds)) : null;
      const end = info.durationSec || from + (asked ?? PLAY_UNKNOWN_SEC);
      const until = asked ? Math.min(end, from + asked) : end;
      const { video, replaced } = show.playVideo({ bvid: `dy${info.awemeId}`, title: info.title, up: info.author, url: info.playUrl, fromSec: from, untilSec: until });
      const outcome = show.stage.watchers ? await show.player.waitStart(video.id, PLAY_CONFIRM_MS) : 'playing';
      if (outcome === 'error') return `「${info.title}」没放出来（舞台加载不了${video.error ? `：${video.error}` : ''}），舞台换回了聊天的布局。可以换一条。`;
      const lines = [
        `舞台上在放抖音视频「${info.title}」（${info.author}），${clock(from)}–${clock(until)}。`,
        '放的时候弹幕照常发给你；想停用 stop_video。',
      ];
      if (replaced) lines.push(`（换掉了正在放的「${replaced.title}」）`);
      if (!show.stage.watchers) lines.push('（现在没有出声的舞台页开着：观众看不到画面，按时长算放完）');
      return lines.join('\n');
    },
  })), 'play_douyin_video tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stop_video',
    description: '停下舞台上正在放的视频，舞台换回聊天的布局。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('stop_video', '');
      const stopped = show.stopVideo();
      if (!stopped) return '现在没在放视频。';
      return `停了「${stopped.video.title}」（放了 ${clock(stopped.playedSec)}），舞台换回了聊天的布局。`;
    },
  })), 'stop_video tool');

  // 游戏线：另一个会话里的她专门玩游戏，这条线把话交给她
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_side',
    description: '定下游戏里接下来怎么玩：开游戏、换目标、照观众的主意换个做法、停手。写下来，游戏里接下来就照着做（具体怎么做看游戏里的情况），做的事和说的话观众都看得到。',
    parameters: {
      message: { type: 'string', required: true, description: '接下来怎么玩，比如「开 Minecraft 接着玩，目标一身钻石装备」「观众提醒天黑了：先挖洞躲起来」' },
    },
    output: stringOut,
    async execute(args) {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) return '没写接下来怎么玩。';
      show.toolCall('game_side', message.slice(0, 40));
      if (!show.toGameLine(message)) return '这场直播没开游戏（开播时没准备游戏），玩不了。';
      return '记下了：游戏里接下来照这个做。';
    },
  })), 'game_side tool');
}
