/**
 * 直播注意力：看着直播间发生的一切，在她能开口时挑出「现在最值得说的一件事」。
 *
 * 她一次只能说一句（一句 4–8 秒），一分钟最多顾得上七八件事；2000 人在线的房间一分钟有六十多条弹幕、
 * 九十次进场。所以这里做的是取舍，按房间热度换策略：
 *   - 冷清（弹幕 < 8 条/分）：几乎每条都接，新来的人点名欢迎，小礼物也谢。
 *   - 一般：挑有内容的接，进场和小礼物攒一批再说。
 *   - 热闹（≥ 30 条/分）：只接问题、点她名的、舰长和老粉；刷屏合成一句「大家都在刷 xx」；进场只欢迎舰长。
 * 醒目留言和上舰无论多忙都要说到；弹幕会随时间「凉掉」，过一会儿再回就不自然了。
 *
 * 直播间没人在看时什么都不做（省 LLM 和 TTS）：不出环节拍、不冷场找话，等有人来了再说。
 * 直播间没开播时是排练（主人在测试）：不管有没有人都照常演。
 *
 * 这里没有时钟、没有 IO：所有方法都接收 now，方便拿录下来的直播回放测试。
 */

import { isHighFanLevel } from '../live';
import type {
  LiveChatEvent,
  LiveEvent,
  LiveGiftEvent,
  LiveMembershipEvent,
  LiveSuperChatEvent,
  LiveUser,
} from '../live';
import { sanitizeChat } from '../safety';
import { chatFeatures, type ChatFeatures } from './features';
import type { ChatPick, RoomHeat, Topic, TopicBody } from './topics';

/** 可调参数集中在这里 */
/** 主人定的节奏（控制台「节奏」里填的；没填的项不出现，按热度自动） */
export interface OwnerPace {
  /** 两次欢迎新观众至少隔多久 */
  welcomeGapMs?: number;
  /** 不欢迎新观众 */
  welcomeOff?: boolean;
  /** 两次感谢小礼物至少隔多久（大礼物、醒目留言、上舰照常马上谢） */
  thanksGapMs?: number;
  /** 两次感谢关注至少隔多久 */
  followGapMs?: number;
  /** 一次弹幕话题最多接几位观众 */
  chatPicks?: number;
}

export const TUNING = {
  /**
   * 冷清 / 正常 / 热闹：看最近一分钟有几个人在说话（不是几条弹幕，也不是在线人数）。
   * 一个人刷得再快也只算一个人；在线很多但只有一个人说话，也是冷清——她要好好陪这一个人聊。
   * 真实直播间里一个人一分钟大约发一条（热闹的房间每分钟 34～77 人、46～111 条），所以分档和以前按条数时一样
   */
  heat: { quietBelowPerMin: 8, busyFromPerMin: 30 },
  /** 弹幕「凉掉」的时间常数（秒）：分数按 e^(-age/τ) 衰减，超过 3τ 丢弃 */
  chatTauSec: { quiet: 90, normal: 40, busy: 20 } as Record<RoomHeat, number>,
  /** 低于这个分数的弹幕不值得专门开口 */
  chatThreshold: { quiet: 0.1, normal: 0.35, busy: 0.6 } as Record<RoomHeat, number>,
  /** 一次最多接几位观众 */
  chatPicks: { quiet: 1, normal: 2, busy: 3 } as Record<RoomHeat, number>,
  /**
   * 刚回过的人：这么久之内他再说话，算在接她刚才的话。
   * 有别人在排队时他的分数打折（别老回同一个人）；只有他在说话时不打折——冷清的直播间常常就一个人在聊
   */
  answeredCooldownMs: 120_000,
  trend: { windowMs: 20_000, minUsers: { quiet: 3, normal: 3, busy: 5 } as Record<RoomHeat, number>, cooldownMs: 120_000 },
  /** 达到这个金额的礼物单独点名感谢（元） */
  bigGiftYuan: 5,
  /** 礼物连击停下这么久才算送完，免得谢的时候数量还在涨 */
  comboSettleMs: 3_000,
  /** 两次感谢小礼物之间至少间隔 */
  giftsIntervalMs: { quiet: 0, normal: 20_000, busy: 45_000 } as Record<RoomHeat, number>,
  welcomeIntervalMs: { quiet: 0, normal: 60_000, busy: 90_000 } as Record<RoomHeat, number>,
  followIntervalMs: { quiet: 0, normal: 20_000, busy: 60_000 } as Record<RoomHeat, number>,
  /** 进场后等一小会儿，把前后脚进来的人一起欢迎 */
  welcomeGatherMs: 2_500,
  welcomeTtlMs: 90_000,
  /** 没话题时多久开始自己找话说 */
  idleAfterMs: 45_000,
  audience: {
    /** 最近这么久有观众动静（进场、弹幕、礼物、点赞……）就算有人在看 */
    activityMs: 5 * 60_000,
    /** 在线人数到这个数也算有人：B 站的在线人数把我们自己的弹幕连接也算进去了，1 就是没人 */
    minOnline: 2,
  },
  maxPendingChats: 200,
};

interface ChatCandidate {
  event: LiveChatEvent;
  /** 收到的时间（不用平台时间戳，免得两边时钟不一致） */
  at: number;
  text: string;
  uid: string;
  features: ChatFeatures;
  /** 不随时间变的部分 */
  base: number;
  tags: string[];
}

interface UserMemory {
  firstSeenAt: number;
  chats: number;
  answeredAt?: number;
}

const GUARD_TAG: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' };

export interface AttentionSnapshot {
  heat: RoomHeat;
  /** 有没有人在看 */
  audience: boolean;
  chatsPerMin: number;
  pending: {
    chats: number;
    superchats: number;
    thanks: number;
    gifts: number;
    welcome: number;
    follow: number;
    trends: number;
  };
}

export class LiveAttention {
  private chats: ChatCandidate[] = [];
  private superchats: LiveSuperChatEvent[] = [];
  private bigThanks = new Map<string, LiveGiftEvent | LiveMembershipEvent>();
  private smallGifts = new Map<string, LiveGiftEvent>();
  private enters: Array<{ user: LiveUser; at: number }> = [];
  private follows: Array<{ user: LiveUser; at: number }> = [];
  /** 主人用主播号发的弹幕（搭档说话，走 owner 话题） */
  private ownerChats: string[] = [];
  private trendHits = new Map<string, Array<{ uid: string; text: string; at: number }>>();
  private trendCooldown = new Map<string, number>();

  private users = new Map<string, UserMemory>();
  /** 这场已经打过招呼的人（欢迎过或回过他的话） */
  private greeted = new Set<string>();
  /** 最近一分钟的弹幕：什么时候、谁发的（冷热按人数算） */
  private chatTimes: Array<{ at: number; uid: string }> = [];
  /** 没话题时多久开始自己找话说；可在直播中调整 */
  idleAfterMs = TUNING.idleAfterMs;
  /** 话痨模式：直播间没人在看的时候也接着说，冷场间隔一口气压短（默认关：没人看就不烧 LLM 和配音） */
  soloTalk = false;
  /** 话痨模式下没人在看时，两次开口之间隔多久 */
  soloIdleMs = 8_000;

  private lastSpeechEndAt: number;
  private speaking = false;
  private lastSaid: Partial<Record<TopicBody['kind'], number>> = {};
  /** 欢迎至少隔这么久（她在玩游戏时设成 90 秒：人多的晚上进场一直来，每次都欢迎她就一直没空玩） */
  welcomeGapMs = 0;
  /** 一次弹幕话题至少挑几位观众（她在玩游戏时设成 3：推得少，每次多带几条） */
  minChatPicks = 0;
  /** 主人在控制台定的节奏：定了的按主人的（盖过按热度的值和玩游戏时的下限），没定的照旧自动 */
  owner: OwnerPace = {};
  /** 最近一次有观众动静的时间 */
  private lastAudienceAt = -Infinity;
  private online: number | undefined;
  private anchorId = '';
  private rehearsal = false;
  private seq = 0;

  constructor(now: number) {
    this.lastSpeechEndAt = now;
  }

  // ── 输入 ─────────────────────────────────────────────

  /** 有观众动静（主播自己，比如开着自己直播间的页面，不算） */
  noteAudience(event: LiveEvent, now: number): void {
    if (!this.anchorId || event.user.id !== this.anchorId) this.lastAudienceAt = now;
  }

  observe(event: LiveEvent, isUpdate: boolean, now: number): void {
    this.noteAudience(event, now);
    switch (event.kind) {
      case 'chat': if (!isUpdate) this.observeChat(event, now); break;
      case 'superchat': if (!isUpdate) this.superchats.push(event); break;
      case 'membership': this.bigThanks.set(event.id, event); break;
      case 'gift':
        if (event.valueYuan >= TUNING.bigGiftYuan) {
          this.smallGifts.delete(event.id); // 连击累计到了大额
          this.bigThanks.set(event.id, event);
        } else {
          this.smallGifts.set(event.id, event);
        }
        break;
      case 'enter': this.observeEnter(event.user, now); break;
      case 'follow': if (!isUpdate && !this.isOwner(event.user)) this.follows.push({ user: event.user, at: now }); break;
      default: break;
    }
  }

  /** 平台推来的在线人数（没开播时平台不推，为 undefined） */
  setOnline(online: number | undefined): void {
    this.online = online;
  }

  setAnchorId(id: string | undefined): void {
    this.anchorId = id ?? '';
  }

  /** 直播间没开播（测试、排练）：没人在看也照常演 */
  setRehearsal(on: boolean): void {
    this.rehearsal = on;
  }

  get isRehearsal(): boolean {
    return this.rehearsal;
  }

  audiencePresent(now: number): boolean {
    if (this.rehearsal) return true;
    return now - this.lastAudienceAt < TUNING.audience.activityMs || (this.online ?? 0) >= TUNING.audience.minOnline;
  }

  speechStarted(): void {
    this.speaking = true;
  }

  speechEnded(now: number): void {
    this.speaking = false;
    this.lastSpeechEndAt = now;
  }

  /** 她多久没说话了（正在说为 0） */
  silentMs(now: number): number {
    return this.speaking ? 0 : now - this.lastSpeechEndAt;
  }

  // ── 输出 ─────────────────────────────────────────────

  heat(now: number): RoomHeat {
    const perMin = this.chattersPerMin(now);
    if (perMin >= TUNING.heat.busyFromPerMin) return 'busy';
    if (perMin < TUNING.heat.quietBelowPerMin) return 'quiet';
    return 'normal';
  }

  /** 挑出现在最该说的话题，并把它用掉；没有值得说的返回 null */
  next(now: number): Topic | null {
    this.prune(now);
    const heat = this.heat(now);
    const audience = this.audiencePresent(now);
    const candidates: Array<{ priority: number; build: () => TopicBody }> = [];

    const sc = this.superchats[0];
    if (sc) candidates.push({ priority: 100, build: () => ({ kind: 'superchat', event: this.superchats.shift()! }) });

    if (this.ownerChats.length) {
      candidates.push({ priority: 95, build: () => ({ kind: 'owner', text: this.ownerChats.splice(0).join(' ') }) });
    }

    const thanks = [...this.bigThanks.values()].filter((e) => this.settled(e, now));
    if (thanks.length) {
      candidates.push({
        priority: 90,
        build: () => {
          const picked = thanks.sort((a, b) => b.valueYuan - a.valueYuan).slice(0, 3);
          for (const e of picked) this.bigThanks.delete(e.id);
          return { kind: 'thanks', events: picked };
        },
      });
    }

    const chat = this.chatCandidate(heat, now);
    if (chat) candidates.push(chat);

    const trend = this.trendCandidate(heat, now);
    if (trend) candidates.push(trend);

    const gifts = this.giftsCandidate(heat, now);
    if (gifts) candidates.push(gifts);

    const follow = this.followCandidate(heat, now);
    if (follow) candidates.push(follow);

    const welcome = this.welcomeCandidate(heat, now);
    if (welcome) candidates.push(welcome);

    if (!candidates.length) {
      const silentMs = now - this.lastSpeechEndAt;
      if (this.speaking) return null;
      // 没人在看的时候平常不开口（省 LLM 和配音）；话痨模式照说，而且隔得短，听起来是连着在说
      const solo = this.soloTalk && !audience;
      if (!audience && !this.soloTalk) return null;
      const wait = solo ? Math.min(this.idleAfterMs, this.soloIdleMs) : this.idleAfterMs;
      if (silentMs < wait) return null;
      candidates.push({ priority: 1, build: () => ({ kind: 'idle', silentMs }) });
    }

    candidates.sort((a, b) => b.priority - a.priority);
    const best = candidates[0];
    const body = best.build();
    this.lastSaid[body.kind] = now;
    return { ...body, id: `topic-${++this.seq}`, priority: best.priority, heat, createdAt: now };
  }

  snapshot(now: number): AttentionSnapshot {
    this.prune(now);
    return {
      heat: this.heat(now),
      audience: this.audiencePresent(now),
      chatsPerMin: this.chatsPerMin(now),
      pending: {
        chats: this.chats.length,
        superchats: this.superchats.length,
        thanks: this.bigThanks.size,
        gifts: this.smallGifts.size,
        welcome: this.enters.length,
        follow: this.follows.length,
        trends: [...this.trendHits.values()].filter((hits) => hits.length > 1).length,
      },
    };
  }

  // ── 弹幕 ─────────────────────────────────────────────

  private observeChat(event: LiveChatEvent, now: number): void {
    const clean = sanitizeChat(event);
    const uid = clean.uid;
    // 主人用主播号发弹幕：是搭档在跟她说话，不是观众
    if (this.isOwner(event.user)) {
      if (clean.text && !event.emoteOnly) this.ownerChats.push(clean.text);
      return;
    }
    this.chatTimes.push({ at: now, uid });
    const memory = this.remember(uid, now);
    memory.chats += 1;

    const features = chatFeatures(clean.text);
    // 刷屏统计算上表情和「哈哈哈」：它们单条没内容，但很多人一起刷就是氛围
    if (features.trendKey) {
      const hits = this.trendHits.get(features.trendKey) ?? [];
      hits.push({ uid, text: clean.text, at: now });
      this.trendHits.set(features.trendKey, hits);
    }
    // 先接了这个人的话，就不用再单独欢迎他
    this.enters = this.enters.filter((e) => (e.user.id || e.user.name) !== uid);

    if (event.emoteOnly || clean.riskFlags.length || !clean.text) return;

    // 内容分：有没有话可接。她刚回过他、他又说话：是在接她的话，「嗯」「是的」「哈哈」也是回应，不算没内容
    const tags: string[] = [];
    const replying = memory.answeredAt !== undefined && now - memory.answeredAt < TUNING.answeredCooldownMs;
    let base = features.lowContent ? (replying ? 0.4 : 0.15) : 0.5;
    if (replying) tags.push('在接你刚才跟他说的话');
    if (features.question) { base += 0.5; tags.push('问题'); }
    if (features.mentionsHer) { base += 0.7; tags.push('点名'); }
    else if (features.addressesHer) { base += 0.15; }
    if (!features.lowContent) {
      if (features.length >= 8) base += 0.15;
      else if (features.length <= 3) base -= 0.15;
    }
    if (features.greeting) tags.push('打招呼');
    if (this.greeted.has(uid)) tags.push('这场已经打过招呼了：别再欢迎，也别说他是第一次来');
    else if (memory.chats === 1) tags.push('本场第一次说话');
    // 身份只放大内容分：高等级观众刷「哈哈哈」也还是没话可接
    const guard = event.user.guardLevel ?? 0;
    if (GUARD_TAG[guard]) { base *= 1.25; tags.push(GUARD_TAG[guard]); }
    if (event.user.honorLevel) tags.push(`抖音荣誉等级${event.user.honorLevel}级`);
    const medal = event.user.medal?.ofThisRoom ? event.user.medal.level : 0;
    if (isHighFanLevel(medal, event.platform)) { base *= 1.1; tags.push(`${event.platform === 'douyin' ? '粉丝团' : '粉丝牌'}${medal}级`); }
    if (event.user.isAdmin) { base *= 1.05; tags.push('房管'); }

    this.chats.push({ event, at: now, text: clean.text, uid, features, base, tags });
    if (this.chats.length > TUNING.maxPendingChats) this.chats.shift();
  }

  private chatScore(c: ChatCandidate, heat: RoomHeat, now: number): number {
    const ageSec = Math.max(0, now - c.at) / 1000;
    let score = c.base * Math.exp(-ageSec / TUNING.chatTauSec[heat]);
    // 刚回过的人打折，只在有别人等着的时候：让一让别人；没别人就照常接他的话
    const answeredAt = this.users.get(c.uid)?.answeredAt;
    const othersWaiting = this.chats.some((o) => o.uid !== c.uid);
    if (othersWaiting && answeredAt !== undefined && now - answeredAt < TUNING.answeredCooldownMs) score *= 0.4;
    return score;
  }

  private chatCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    const threshold = TUNING.chatThreshold[heat];
    const scored = this.chats
      .map((c) => ({ c, score: this.chatScore(c, heat, now) }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return null;

    return {
      priority: Math.min(85, 50 * scored[0].score),
      build: () => {
        const picks: ChatPick[] = [];
        const taken = new Set<string>();
        for (const { c, score } of scored) {
          if (picks.length >= (this.owner.chatPicks ?? Math.max(TUNING.chatPicks[heat], this.minChatPicks))) break;
          if (taken.has(c.uid)) continue;
          taken.add(c.uid);
          // 这个人还没回的话全部按顺序合成一句交给她（她说话的十几秒里他可能又发了好几条，一条都不能丢）
          const mine = this.chats.filter((o) => o.uid === c.uid).sort((a, b) => a.at - b.at);
          const text = mine.map((o) => o.text).join(' ');
          picks.push({ event: c.event, text, tags: [...new Set(mine.flatMap((o) => o.tags))], score });
        }
        for (const uid of taken) {
          this.remember(uid, now).answeredAt = now;
          this.greeted.add(uid);
        }
        this.chats = this.chats.filter((o) => !taken.has(o.uid));
        return { kind: 'chat', picks };
      },
    };
  }

  // ── 刷屏 ─────────────────────────────────────────────

  private trendCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    let best: { key: string; users: number } | null = null;
    for (const [key, hits] of this.trendHits) {
      if ((this.trendCooldown.get(key) ?? 0) > now) continue;
      const users = new Set(hits.map((h) => h.uid)).size;
      if (users >= TUNING.trend.minUsers[heat] && (!best || users > best.users)) best = { key, users };
    }
    if (!best) return null;
    const { key, users } = best;
    return {
      priority: 45 + Math.min(20, users * 2),
      build: () => {
        const hits = this.trendHits.get(key) ?? [];
        this.trendHits.delete(key);
        this.trendCooldown.set(key, now + TUNING.trend.cooldownMs);
        const uids = new Set(hits.map((h) => h.uid));
        // 刷屏的那几条不再单独回
        this.chats = this.chats.filter((c) => !(uids.has(c.uid) && c.features.trendKey === key));
        return { kind: 'trend', key, samples: [...new Set(hits.map((h) => h.text))].slice(0, 3), users };
      },
    };
  }

  // ── 礼物 ─────────────────────────────────────────────

  private settled(e: LiveGiftEvent | LiveMembershipEvent, now: number): boolean {
    return e.kind === 'membership' || now - e.ts >= TUNING.comboSettleMs;
  }

  private giftsCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    // 免费礼物只在冷清的时候谢
    const ready = [...this.smallGifts.values()].filter((g) => this.settled(g, now) && (g.valueYuan > 0 || heat === 'quiet'));
    if (!ready.length) return null;
    if (now - (this.lastSaid.gifts ?? -Infinity) < (this.owner.thanksGapMs ?? TUNING.giftsIntervalMs[heat])) return null;
    const oldest = Math.min(...ready.map((g) => g.ts));
    return {
      priority: Math.min(75, 35 + (now - oldest) / 2000),
      build: () => {
        // 同一个人的礼物合在一起，按金额排
        const byUser = new Map<string, LiveGiftEvent[]>();
        for (const g of ready) {
          this.smallGifts.delete(g.id);
          const key = g.user.id || g.user.name;
          byUser.set(key, [...(byUser.get(key) ?? []), g]);
        }
        const ranked = [...byUser.values()].sort((a, b) => sum(b) - sum(a));
        return { kind: 'gifts', events: ranked.slice(0, 3).flat(), more: Math.max(0, ranked.length - 3) };
      },
    };
  }

  // ── 进场与关注 ───────────────────────────────────────

  private isOwner(user: LiveUser): boolean {
    return !!this.anchorId && user.id === this.anchorId;
  }

  private observeEnter(user: LiveUser, now: number): void {
    const uid = user.id || user.name;
    if (!uid || user.masked || this.isOwner(user)) return;
    const known = this.users.has(uid);
    this.remember(uid, now);
    if (known) return; // 本场来过的不再欢迎
    this.enters.push({ user, at: now });
  }

  private welcomeCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    // 热闹时只欢迎大航海和各平台的高等级粉丝（B 站粉丝牌 20 级、抖音粉丝团 10 级）
    const eligible = this.enters.filter((e) => heat !== 'busy' || (e.user.guardLevel ?? 0) > 0
      || (e.user.medal?.ofThisRoom && isHighFanLevel(e.user.medal.level, e.user.platform)));
    if (!eligible.length || this.owner.welcomeOff) return null;
    if (now - (this.lastSaid.welcome ?? -Infinity) < (this.owner.welcomeGapMs ?? Math.max(TUNING.welcomeIntervalMs[heat], this.welcomeGapMs))) return null;
    if (now - Math.min(...eligible.map((e) => e.at)) < TUNING.welcomeGatherMs) return null;
    return {
      // 冷清时欢迎排在环节拍前面（环节拍最高 55）
      priority: heat === 'quiet' ? 60 : 20,
      build: () => {
        const ranked = eligible.sort((a, b) => notability(b.user) - notability(a.user));
        this.enters = [];
        for (const e of ranked) this.greeted.add(e.user.id || e.user.name);
        return { kind: 'welcome', users: ranked.slice(0, 3).map((e) => e.user), more: Math.max(0, ranked.length - 3) };
      },
    };
  }

  private followCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    if (!this.follows.length) return null;
    if (now - (this.lastSaid.follow ?? -Infinity) < (this.owner.followGapMs ?? TUNING.followIntervalMs[heat])) return null;
    const oldest = this.follows[0].at;
    return {
      priority: Math.min(60, 30 + (now - oldest) / 2000),
      build: () => {
        const users = uniqueUsers(this.follows.map((f) => f.user));
        this.follows = [];
        return { kind: 'follow', users: users.slice(0, 3), more: Math.max(0, users.length - 3) };
      },
    };
  }

  // ── 维护 ─────────────────────────────────────────────

  private remember(uid: string, now: number): UserMemory {
    let memory = this.users.get(uid);
    if (!memory) {
      memory = { firstSeenAt: now, chats: 0 };
      this.users.set(uid, memory);
    }
    return memory;
  }

  private chatsPerMin(now: number): number {
    while (this.chatTimes.length && now - this.chatTimes[0].at > 60_000) this.chatTimes.shift();
    return this.chatTimes.length;
  }

  /** 最近一分钟有几个人在说话 */
  private chattersPerMin(now: number): number {
    this.chatsPerMin(now);
    return new Set(this.chatTimes.map((c) => c.uid)).size;
  }

  private prune(now: number): void {
    const heat = this.heat(now);
    const maxAge = TUNING.chatTauSec[heat] * 3000;
    this.chats = this.chats.filter((c) => now - c.at <= maxAge);
    this.enters = this.enters.filter((e) => now - e.at <= TUNING.welcomeTtlMs);
    this.follows = this.follows.filter((f) => now - f.at <= 5 * 60_000);
    for (const [key, hits] of this.trendHits) {
      const fresh = hits.filter((h) => now - h.at <= TUNING.trend.windowMs);
      if (fresh.length) this.trendHits.set(key, fresh);
      else this.trendHits.delete(key);
    }
    for (const [key, until] of this.trendCooldown) if (until <= now) this.trendCooldown.delete(key);
    // 小礼物等太久就不谢了（热闹时会被更要紧的事挤掉）
    for (const [id, g] of this.smallGifts) if (now - g.ts > 3 * 60_000) this.smallGifts.delete(id);
  }
}

function sum(gifts: LiveGiftEvent[]): number {
  return gifts.reduce((total, g) => total + g.valueYuan, 0);
}

function notability(user: LiveUser): number {
  const guard = user.guardLevel ? 100 - user.guardLevel : 0;
  return guard + (user.medal?.ofThisRoom ? user.medal.level : 0);
}

function uniqueUsers(users: LiveUser[]): LiveUser[] {
  const seen = new Set<string>();
  return users.filter((u) => {
    const key = u.id || u.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
