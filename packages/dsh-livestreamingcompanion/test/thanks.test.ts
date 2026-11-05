import { describe, expect, it } from 'vitest';
import { thanksText } from '../src/core/thanks';
import type { Topic } from '../src/core/attention/topics';
import type { LiveUser } from '../src/core/live';

const base = { id: 't', priority: 50, heat: 'quiet' as const, createdAt: 0 };
const user = (id: string, name = `观众${id}`): LiveUser => ({ id, name });

describe('deterministic viewer thanks', () => {
  it('speaks actual like counts and shares without model generation', () => {
    const topic: Topic = {
      ...base,
      kind: 'support',
      likes: [{ user: user('1', '小明'), count: 12 }],
      shares: [{ user: user('2', '小红'), count: 1 }],
      overflow: false,
    };
    expect(thanksText(topic)).toBe('谢谢小明点的12个赞、小红分享直播！');
  });

  it('uses gift and membership data without quoting prices', () => {
    const topic: Topic = {
      ...base,
      kind: 'thanks',
      events: [
        { id: 'g', platform: 'bilibili', kind: 'gift', ts: 0, user: user('1', '小明'), giftName: '火箭', count: 2, valueYuan: 2000 },
        { id: 'm', platform: 'bilibili', kind: 'membership', ts: 0, user: user('2', '小红'), levelName: '舰长', level: 3, count: 1, valueYuan: 198 },
      ],
    };
    const text = thanksText(topic);
    expect(text).toContain('小明送的火箭×2');
    expect(text).toContain('小红开通的舰长');
    expect(text).not.toContain('2000');
    expect(text).not.toContain('198');
  });

  it('covers unnamed overflow collectively and sanitizes names', () => {
    const topic: Topic = {
      ...base,
      kind: 'support',
      likes: [{ user: user('1', '  小明\n'), count: 1 }],
      shares: [],
      overflow: true,
    };
    expect(thanksText(topic)).toBe('谢谢小明点的赞，也谢谢其他朋友的点赞和分享！');
  });

  it('keeps conversational paid messages on the model path', () => {
    const topic: Topic = {
      ...base,
      kind: 'superchat',
      event: { id: 's', platform: 'bilibili', kind: 'superchat', ts: 0, user: user('1'), text: '加油', valueYuan: 30 },
    };
    expect(thanksText(topic)).toBeNull();
  });
});
