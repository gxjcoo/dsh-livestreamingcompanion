import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { decodePushFrame, type DouyinContext } from '../src/core/platforms/douyin/douyinDecode';
import { parseDouyinRoom } from '../src/core/platforms/douyin/douyinApi';
import { cookieReport, douyinSearchText, parseDouyinVideo, parseSearch, searchQuery } from '../src/body/douyinVideo';
import type { LiveEvent } from '../src/core/live';
import { gzipSync } from 'zlib';

const FIXTURES = path.join(__dirname, 'fixtures', 'douyin');
const hasFixtures = fs.existsSync(path.join(FIXTURES, 'chat.jsonl'));
const CTX: DouyinContext = { roomId: '7701485472337513252', anchorId: '1' };

function decodeAll(name: string) {
  const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { b64: string });
  const events: LiveEvent[] = [];
  const stats: Array<Record<string, number>> = [];
  for (const line of lines) {
    for (const out of decodePushFrame(Buffer.from(line.b64, 'base64'), CTX, 1_700_000_000_000)) {
      if (out.type === 'event') events.push(out.event);
      else if (out.type === 'stats') stats.push(out.stats as Record<string, number>);
    }
  }
  return { events, stats };
}

// ── 合成一帧：验证礼物、心跳、gzip 这几条自己写的路径 ─────────

function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
function field(num: number, wire: 0 | 2, payload: Buffer | number): Buffer {
  const head = varint((num << 3) | wire);
  if (wire === 0) return Buffer.concat([head, varint(payload as number)]);
  const body = payload as Buffer;
  return Buffer.concat([head, varint(body.length), body]);
}
const s = (num: number, text: string) => field(num, 2, Buffer.from(text, 'utf8'));
const n = (num: number, value: number) => field(num, 0, value);

function frame(messages: Buffer[], opts: { gzip?: boolean; type?: string } = {}): Buffer {
  let payload = Buffer.concat(messages.map((m) => field(1, 2, m)));
  if (opts.gzip) payload = gzipSync(payload);
  const parts = [n(1, 1), s(6, 'pb'), s(7, opts.type ?? 'msg'), field(8, 2, payload)];
  return Buffer.concat(parts);
}

function giftMessage(input: { userId: string; name: string; giftId: number; repeat: number; group: string; diamond: number }): Buffer {
  const user = Buffer.concat([n(1, Number(input.userId)), s(3, input.name)]);
  const gift = Buffer.concat([s(2, '小心心'), n(12, input.diamond)]);
  const body = Buffer.concat([n(2, input.giftId), n(5, input.repeat), field(7, 2, user), n(9, 1), field(11, 2, Buffer.from(input.group, 'utf8')), field(15, 2, gift)]);
  return Buffer.concat([s(1, 'WebcastGiftMessage'), field(2, 2, body)]);
}

function chatMessage(input: { userId: string; name: string; honorLevel: number; clubName: string; clubLevel: number }): Buffer {
  const club = field(24, 2, field(1, 2, Buffer.concat([s(1, input.clubName), n(2, input.clubLevel)])));
  const user = Buffer.concat([n(1, Number(input.userId)), s(3, input.name), n(6, input.honorLevel), club]);
  const body = Buffer.concat([field(2, 2, user), s(3, '晚上好')]);
  return Buffer.concat([s(1, 'WebcastChatMessage'), field(2, 2, body)]);
}

describe.runIf(hasFixtures)('douyin decode (real recordings)', () => {
  it('reads chat, enters, likes, follows and room stats from a busy room', () => {
    const { events, stats } = decodeAll('chat.jsonl');
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    expect(count('chat')).toBeGreaterThan(100);
    expect(count('enter')).toBeGreaterThan(20);
    expect(count('like')).toBeGreaterThan(5);
    // 匿名进房：名字被打成「素***」这种
    const chats = events.filter((e) => e.kind === 'chat');
    expect(chats.every((c) => c.user.name.length > 0)).toBe(true);
    expect(chats.some((c) => c.user.masked)).toBe(true);
    // 真实录制里能读到抖音荣誉等级；它绝不能被当成 B 站大航海
    expect(chats.some((c) => (c.user.honorLevel ?? 0) > 0)).toBe(true);
    expect(chats.every((c) => c.user.guardLevel === undefined)).toBe(true);
    // 在线人数是秒级的推送，取最后一个
    const online = stats.filter((x) => 'online' in x).at(-1);
    expect(online?.online).toBeGreaterThan(0);
  });

  it('gives a repeated message the same id (so the hub merges it instead of double counting)', () => {
    const { events } = decodeAll('chat.jsonl');
    const byId = new Map<string, LiveEvent[]>();
    for (const event of events) byId.set(event.id, [...(byId.get(event.id) ?? []), event]);
    const repeated = [...byId.values()].filter((list) => list.length > 1);
    // 抖音会把同一批消息重发一遍：同 id 的必须是同一条消息（同样的观众、同样的内容）
    for (const list of repeated) {
      const first = list[0];
      for (const event of list.slice(1)) {
        expect(event.kind).toBe(first.kind);
        expect(event.user.id).toBe(first.user.id);
        if (event.kind === 'chat' && first.kind === 'chat') expect(event.text).toBe(first.text);
      }
    }
    expect(repeated.length).toBeGreaterThan(0);
  });

  it('reads likes/follows from a room without chat', () => {
    const { events } = decodeAll('social.jsonl');
    expect(events.filter((e) => e.kind === 'chat').length).toBe(0);
    expect(events.filter((e) => e.kind === 'like').length).toBeGreaterThan(10);
    expect(events.filter((e) => e.kind === 'enter').length).toBeGreaterThan(10);
  });
});

describe('douyin framing', () => {
  it('ignores heartbeat frames', () => {
    const hb = Buffer.concat([s(7, 'hb')]);
    expect(decodePushFrame(hb, CTX)).toEqual([]);
  });

  it('gunzips a gzip payload', () => {
    const raw = frame([giftMessage({ userId: '42', name: '小明', giftId: 5655, repeat: 3, group: 'g1', diamond: 1 })]);
    const gz = frame([giftMessage({ userId: '42', name: '小明', giftId: 5655, repeat: 3, group: 'g1', diamond: 1 })], { gzip: true });
    const a = decodePushFrame(raw, CTX, 1);
    const b = decodePushFrame(gz, CTX, 1);
    expect(b).toEqual(a);
  });

  it('keeps Douyin honor and fans-club levels separate from Bilibili guard levels', () => {
    const output = decodePushFrame(frame([chatMessage({ userId: '42', name: '小明', honorLevel: 37, clubName: '鱼粉团', clubLevel: 12 })]), CTX, 1);
    const event = output.find((o) => o.type === 'event');
    expect(event && event.type === 'event' ? event.event.user : null).toMatchObject({
      id: '42',
      platform: 'douyin',
      honorLevel: 37,
      medal: { name: '鱼粉团', level: 12, ofThisRoom: true },
    });
    expect(event && event.type === 'event' ? event.event.user.guardLevel : 1).toBeUndefined();
  });

  it('turns diamonds into yuan and merges a combo by user+gift+group', () => {
    const first = decodePushFrame(frame([giftMessage({ userId: '42', name: '小明', giftId: 5655, repeat: 1, group: 'g1', diamond: 5 })]), CTX, 1);
    const event = first.find((o) => o.type === 'event');
    expect(event && event.type === 'event' ? event.event : null).toMatchObject({
      kind: 'gift',
      giftName: '小心心',
      count: 1,
      diamonds: 5,
      valueYuan: 0.5,
      user: { id: '42', name: '小明', platform: 'douyin' },
    });
    const second = decodePushFrame(frame([giftMessage({ userId: '42', name: '小明', giftId: 5655, repeat: 4, group: 'g1', diamond: 5 })]), CTX, 2);
    const again = second.find((o) => o.type === 'event');
    const id1 = event?.type === 'event' ? event.event.id : '';
    const id2 = again?.type === 'event' ? again.event.id : '';
    expect(id2).toBe(id1);
    expect(again?.type === 'event' && again.event.kind === 'gift' ? again.event.diamonds : 0).toBe(20);
  });
});

describe('douyin search', () => {
  const payload = {
    status_code: 0,
    data: [
      {
        type: 1,
        aweme_info: {
          aweme_id: '7697621631518166282',
          desc: '猫猫 #猫 #萌宠',
          author: { nickname: '甲', sec_uid: 'SEC1' },
          video: { duration: 12345, cover: { url_list: ['https://x/cover.jpg'] } },
          statistics: { digg_count: 36000, comment_count: 12 },
          create_time: 1_760_000_000,
        },
      },
      { type: 4, user_list: [] },
      { type: 1 },
      {
        type: 1,
        aweme_mix_info: { aweme_list: [{ aweme_id: '7001', desc: '合集里的', author: { nickname: '乙' }, video: { duration: 1000 }, statistics: {} }] },
      },
    ],
  };

  it('keeps video hits and skips users / empty items', () => {
    const hits = parseSearch(payload);
    expect(hits.map((h) => h.awemeId)).toEqual(['7697621631518166282', '7001']);
    expect(hits[0]).toMatchObject({ author: '甲', durationSec: 12, likes: 36000 });
    expect(hits[1].likes).toBe(0);
  });

  it('builds the same query the web page sends (offset / sort / channel)', () => {
    const q = searchQuery('猫', 2, 'likes');
    expect(q).toContain('offset=12');
    expect(q).toContain('count=12');
    expect(q).toContain('sort_type=2');
    expect(q).toContain('search_channel=aweme_video_web');
    expect(q).toContain('keyword=%E7%8C%AB');
  });

  it('renders numbered hits with ids and next-step hints', () => {
    const text = douyinSearchText('猫', { hits: parseSearch(payload), via: 'page' }, { page: 1 });
    expect(text).toContain('7697621631518166282');
    expect(text).toContain('@甲');
    expect(text).toContain('页面抓取');
    expect(text).toContain('play_douyin_video');
  });

  it('passes the login gate message through unchanged', () => {
    const message = '搜抖音要登录：填 Cookie';
    expect(douyinSearchText('猫', { error: 'login', message })).toBe(message);
  });

  it('says so when nothing matched', () => {
    expect(douyinSearchText('冷门词', { hits: [], via: 'http' }, { page: 1 })).toContain('一条也没搜到');
  });
});

describe('douyin cookie report', () => {
  it('treats an anonymous jar as not logged in', () => {
    const report = cookieReport('ttwid=abc; odin_tt=def; UIFID_TEMP=ghi');
    expect(report.count).toBe(3);
    expect(report.hasTtwid).toBe(true);
    expect(report.hasSession).toBe(false);
  });

  it('recognises sessionid / sid_tt as a login', () => {
    expect(cookieReport('ttwid=a; sessionid=b').hasSession).toBe(true);
    expect(cookieReport('sid_tt=c').hasSession).toBe(true);
    expect(cookieReport('sessionid_ss=d').hasSession).toBe(true);
  });

  it('ignores empty and malformed parts', () => {
    expect(cookieReport('').count).toBe(0);
    expect(cookieReport('; ; foo').count).toBe(0);
    expect(cookieReport('a=1; ; b=2').names).toEqual(['a', 'b']);
  });
});

describe('douyin parsing', () => {
  it('understands web_rid inputs', () => {
    expect(parseDouyinRoom('123456')).toBe(123456);
    expect(parseDouyinRoom('https://live.douyin.com/193671986973')).toBe(193671986973);
    expect(parseDouyinRoom('https://live.douyin.com/1?web_rid=760827')).toBe(760827);
    expect(parseDouyinRoom('abc')).toBeNull();
  });

  it('understands video ids and links', () => {
    expect(parseDouyinVideo('7697621631518166282')).toBe('7697621631518166282');
    expect(parseDouyinVideo('https://www.douyin.com/video/7697621631518166282')).toBe('7697621631518166282');
    expect(parseDouyinVideo('看看这个 https://v.douyin.com/iAbCdEf/ 好玩')).toBeNull();
    expect(parseDouyinVideo('随便一句话')).toBeNull();
  });
});
