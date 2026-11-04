/**
 * 抖音直播推送帧 → 统一直播事件。
 *
 * 字段号来自 2026-10 实测（用 Chrome 打开三个真实直播间，抓页面自己收的帧，
 * 见 tools/douyin-capture.mjs / tools/douyin-decode-dump.mjs）：
 *
 *   PushFrame { 1 seqId, 2 logId, 6 payloadEncoding, 7 payloadType, 8 payload }
 *   Response  { 1 messages, 2 cursor, 8 heartbeatDuration, 9 needAck }
 *   Message   { 1 method, 2 payload, 3 msgId }
 *   Chat      { 1 common, 2 user, 3 content }
 *   Member    { 1 common, 2 user, 3 memberCount, 9 enterType, 10 action }
 *   Gift      { 1 common, 2 giftId, 5 repeatCount, 6 comboCount, 7 user, 9 repeatEnd, 11 groupId, 15 gift }
 *   Like      { 1 common, 2 count, 3 total, 5 user }
 *   Social    { 1 common, 2 user, 3 shareType }
 *   RoomUserSeq { 3 total, 7 totalUser, 10 onlineUserForAnchor }
 *   RoomStats { 5 displayValue, 9 total }
 *   Control   { 2 status }（3 = 下播）
 *
 * 礼物连击：每帧都是累计值（repeatCount 不断变大），只有 repeatEnd=1 才结算；
 * 合并 key 用 user.id + giftId + groupId（group_id 跨用户会撞）。
 */

import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { LiveEvent, LiveRoomStats, LiveUser } from '../../live';
import { pbChild, pbId, pbNumber, pbString, readPb, type PbMessage } from '../pb';

export interface DouyinContext {
  /** 平台给的 room_id（19 位数字，超过 2^53：只当字符串用） */
  roomId: string;
  /** 主播 id：判断粉丝牌是不是本房间的 */
  anchorId: string;
}

export type DouyinOutput =
  | { type: 'event'; event: LiveEvent }
  | { type: 'stats'; stats: Partial<LiveRoomStats> }
  | { type: 'room'; title?: string };

/** giftId → 名字（常见的几个，给没带名字的礼物兜底） */
const GIFT_NAMES: Record<string, string> = {
  '1': '小心心',
  '5655': '玫瑰',
  '33666': '粉丝团灯牌',
  '10134': '抖音',
  '309': '人气票',
  '16560': '大啤酒',
  '16169': '咖啡',
  '31038': '嘉年华',
  '31037': '火箭',
};

/** giftId → 抖币单价（1 元 = 10 抖币） */
const GIFT_DIAMONDS: Record<string, number> = {
  '1': 1,
  '5655': 1,
  '33666': 1,
  '10134': 1,
  '309': 1,
  '16560': 10,
  '16169': 20,
  '31037': 10000,
  '31038': 30000,
};

let seq = 0;
const nextId = (prefix: string) => `dy:${prefix}:${Date.now().toString(36)}${(++seq).toString(36)}`;

/**
 * 弹幕的 id：抖音同一个批次里 common.msgId 会重复（一帧里塞好几条），
 * 所以再拼上观众和内容摘要，保证同一条消息重放时 id 还是一样的（hub 靠它去重）。
 */
function chatId(common: PbMessage | undefined, user: LiveUser, text: string): string {
  const msgId = pbId(common, 2);
  const digest = createHash('md5').update(`${user.id}|${text}`).digest('hex').slice(0, 10);
  return `dy:dm:${msgId || 'x'}:${digest}`;
}

/** User { 1 id, 3 nickname, 6 honorLevel, 9 avatarThumb{1 url_list}, 24 fansClub, 38 displayId, 46 secUid } */
function userOf(msg: PbMessage | undefined, ctx: DouyinContext): LiveUser {
  const id = pbId(msg, 1);
  const name = pbString(msg, 3);
  const avatar = pbChild(msg, 9);
  const urls = avatar?.get(1) ?? [];
  const face = urls.map((u) => (Buffer.isBuffer(u) ? u.toString('utf8') : '')).find((u) => u.startsWith('http'));
  const club = pbChild(pbChild(msg, 24), 1);
  const clubName = pbString(club, 1);
  const clubLevel = pbNumber(club, 2);
  const user: LiveUser = { id, name, platform: 'douyin' };
  if (face) user.face = face.replace(/^http:/, 'https:');
  // 抖音匿名叫「张***」、id 是 111111
  if (!id || id === '111111' || name.includes('***')) user.masked = true;
  if (clubName && clubLevel) user.medal = { name: clubName, level: clubLevel, ofThisRoom: true };
  // 抖音自己的荣誉等级：独立展示，不能塞进 B 站的 guardLevel（舰长 / 提督 / 总督）
  const honorLevel = pbNumber(msg, 6);
  if (honorLevel > 0) user.honorLevel = honorLevel;
  void ctx;
  return user;
}

function chat(body: PbMessage, ctx: DouyinContext, now: number): LiveEvent | null {
  const text = pbString(body, 3);
  const user = userOf(pbChild(body, 2), ctx);
  if (!text) return null;
  return { id: chatId(pbChild(body, 1), user, text), platform: 'douyin', kind: 'chat', ts: now, user, text };
}

function member(body: PbMessage, ctx: DouyinContext, now: number): DouyinOutput[] {
  const action = pbNumber(body, 10);
  const user = userOf(pbChild(body, 2), ctx);
  const count = pbNumber(body, 3);
  const out: DouyinOutput[] = [];
  // 1 进房；2/3/4/5 关注、分享这类（有的版本用 SocialMessage 报）
  if (action === 1) out.push({ type: 'event', event: { id: nextId('enter'), platform: 'douyin', kind: 'enter', ts: now, user } });
  else if (action === 2) out.push({ type: 'event', event: { id: nextId('follow'), platform: 'douyin', kind: 'follow', ts: now, user } });
  if (count > 0) out.push({ type: 'stats', stats: { online: count } });
  return out;
}

function gift(body: PbMessage, ctx: DouyinContext, now: number): LiveEvent | null {
  const g = pbChild(body, 15);
  const giftId = pbId(body, 2) || pbId(g, 5);
  const name = pbString(g, 2) || pbString(g, 16) || GIFT_NAMES[giftId] || `礼物 ${giftId}`;
  const diamond = pbNumber(g, 12) || pbNumber(g, 19) || 0;
  const unit = diamond || GIFT_DIAMONDS[giftId] || 0;
  const count = pbNumber(body, 5) || pbNumber(body, 4) || 1;
  // group_id 是连击的批次号：同一批（同一个人、同一个礼物）的几千条共用它
  const group = pbId(body, 11) || pbString(body, 11) || pbId(body, 16);
  const user = userOf(pbChild(body, 7), ctx);
  const combo = group ? `${user.id}:${giftId}:${group}` : '';
  const diamonds = unit * count;
  return {
    id: combo ? `dy:gift:${combo}` : nextId('gift'),
    platform: 'douyin',
    kind: 'gift',
    ts: now,
    user,
    giftName: name,
    count,
    // 抖币 → 元：1 元 = 10 抖币；舞台同时保留抖音原生的抖币数（价格未知时不谎称 0 抖币）
    ...(diamonds > 0 ? { diamonds } : {}),
    valueYuan: Math.round((diamonds / 10) * 100) / 100,
  };
}

function like(body: PbMessage, ctx: DouyinContext, now: number): DouyinOutput[] {
  const total = pbNumber(body, 3);
  const out: DouyinOutput[] = [];
  if (total > 0) out.push({ type: 'stats', stats: { likes: total } });
  out.push({ type: 'event', event: { id: nextId('like'), platform: 'douyin', kind: 'like', ts: now, user: userOf(pbChild(body, 5), ctx) } });
  return out;
}

function social(body: PbMessage, ctx: DouyinContext, now: number): LiveEvent | null {
  const user = userOf(pbChild(body, 2), ctx);
  const share = pbNumber(body, 3);
  // 3 是分享；关注由 MemberMessage(action=2) 报
  if (share > 0) return { id: nextId('share'), platform: 'douyin', kind: 'share', ts: now, user };
  return { id: nextId('follow'), platform: 'douyin', kind: 'follow', ts: now, user };
}

function roomUserSeq(body: PbMessage): DouyinOutput[] {
  // 10 是在线（onlineUserForAnchor），7 是本场累计看过（totalUser）：
  // 两个别混，混了在线人数会突然跳到本场总人数
  const online = pbNumber(body, 10);
  const watched = pbNumber(body, 7);
  const stats: Partial<LiveRoomStats> = {};
  if (online > 0) stats.online = online;
  if (watched > 0) stats.watched = watched;
  return Object.keys(stats).length ? [{ type: 'stats', stats }] : [];
}

function roomStats(body: PbMessage): DouyinOutput[] {
  const value = pbNumber(body, 9) || pbNumber(body, 5);
  return value > 0 ? [{ type: 'stats', stats: { online: value } }] : [];
}

/** 一条消息体 → 统一事件（method 是 Response 里带的字符串） */
export function decodeDouyinMessage(method: string, body: PbMessage, ctx: DouyinContext, now = Date.now()): DouyinOutput[] {
  const event = (e: LiveEvent | null): DouyinOutput[] => (e ? [{ type: 'event', event: e }] : []);
  switch (method) {
    case 'WebcastChatMessage': return event(chat(body, ctx, now));
    case 'WebcastGiftMessage': return event(gift(body, ctx, now));
    case 'WebcastMemberMessage': return member(body, ctx, now);
    case 'WebcastLikeMessage': return like(body, ctx, now);
    case 'WebcastSocialMessage': return event(social(body, ctx, now));
    case 'WebcastRoomUserSeqMessage': return roomUserSeq(body);
    case 'WebcastRoomStatsMessage': return roomStats(body);
    case 'WebcastRoomMessage': {
      const title = pbString(body, 3);
      return title ? [{ type: 'room', title }] : [];
    }
    case 'WebcastControlMessage': {
      const status = pbNumber(body, 2);
      if (status === 3) return [{ type: 'stats', stats: { live: false } }];
      return [];
    }
    case 'WebcastEmojiChatMessage': {
      const user = userOf(pbChild(body, 2), ctx);
      const text = pbString(body, 5);
      const image = pbString(body, 4);
      if (!text && !image) return [];
      return [
        {
          type: 'event',
          event: { id: chatId(pbChild(body, 1), user, text || image || ''), platform: 'douyin', kind: 'chat', ts: now, user, text: text || '[表情]', ...(image ? { stickerUrl: image, emoteOnly: true } : {}) },
        },
      ];
    }
    case 'WebcastFansclubMessage': {
      const user = userOf(pbChild(body, 4), ctx);
      return event({ id: nextId('membership'), platform: 'douyin', kind: 'membership', ts: now, user, levelName: '粉丝团', level: 1, count: 1, valueYuan: 0 });
    }
    default:
      return [];
  }
}

/** 一帧 PushFrame（base64 或原始字节）→ 若干输出；心跳帧返回 [] */
export function decodePushFrame(raw: Buffer, ctx: DouyinContext, now = Date.now()): DouyinOutput[] {
  let frame: PbMessage;
  try {
    frame = readPb(raw);
  } catch {
    return [];
  }
  const type = pbString(frame, 7);
  if (type === 'hb') return [];
  let payload = frame.get(8)?.[0];
  if (!Buffer.isBuffer(payload) || !payload.length) return [];
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    try {
      payload = gunzipSync(payload);
    } catch {
      return [];
    }
  }
  let res: PbMessage;
  try {
    res = readPb(payload);
  } catch {
    return [];
  }
  const messages = (res.get(1) ?? []).filter((m): m is Buffer => Buffer.isBuffer(m));
  const out: DouyinOutput[] = [];
  for (const m of messages) {
    let msg: PbMessage;
    try {
      msg = readPb(m);
    } catch {
      continue;
    }
    const method = pbString(msg, 1);
    const body = msg.get(2)?.[0];
    if (!method || !Buffer.isBuffer(body)) continue;
    try {
      out.push(...decodeDouyinMessage(method, readPb(body), ctx, now));
    } catch {
      /* 单个消息解不开就跳过 */
    }
  }
  return out;
}
