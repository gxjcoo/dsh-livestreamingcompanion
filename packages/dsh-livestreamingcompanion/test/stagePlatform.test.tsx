import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toStage } from '../src/body/show';
import { topicText } from '../src/core/topicText';
import type { LiveMembershipEvent, LiveUser } from '../src/core/live';
import type { StageLiveEvent } from '../src/stage/protocol';
import type { Alert } from '../src/stage/store';

let Badge: typeof import('../src/stage/widgets').Badge;
let AlertCard: typeof import('../src/stage/widgets').AlertCard;

beforeAll(async () => {
  vi.stubGlobal('location', { search: '' });
  ({ Badge, AlertCard } = await import('../src/stage/widgets'));
});

const douyinUser: LiveUser = {
  id: '42',
  name: '小明',
  platform: 'douyin',
  honorLevel: 37,
  medal: { name: '鱼粉团', level: 12, ofThisRoom: true },
};

function membership(platform: 'bilibili' | 'douyin'): LiveMembershipEvent {
  return {
    id: `member-${platform}`,
    platform,
    kind: 'membership',
    ts: 1,
    user: platform === 'douyin' ? douyinUser : { id: '7', name: '阿杰', platform, guardLevel: 3 },
    levelName: platform === 'douyin' ? '粉丝团' : '舰长',
    level: platform === 'douyin' ? 1 : 3,
    count: 1,
    valueYuan: 0,
  };
}

function alert(event: StageLiveEvent | null): Alert {
  if (!event || event.kind === 'chat') throw new Error('test needs an alert event');
  return { key: event.id, event, at: 1 };
}

describe('platform-specific stage events', () => {
  it('carries Douyin honor level, fans club and diamonds to the stage', () => {
    const event = toStage({
      id: 'gift-1', platform: 'douyin', kind: 'gift', ts: 1, user: douyinUser,
      giftName: '大啤酒', count: 2, diamonds: 20, valueYuan: 2,
    });
    expect(event).toMatchObject({
      platform: 'douyin', diamonds: 20,
      user: { honor: 37, medal: { name: '鱼粉团', level: 12 } },
    });
    expect(event?.user.guard).toBeUndefined();
    const html = renderToStaticMarkup(<Badge user={event!.user} platform={event!.platform} />);
    expect(html).toContain('荣誉');
    expect(html).toContain('37');
    expect(html).toContain('鱼粉团');
    expect(html).toContain('12');
    expect(html).not.toContain('舰长');
  });

  it('keeps the Bilibili guard badge unchanged', () => {
    const event = toStage({
      id: 'chat-bili', platform: 'bilibili', kind: 'chat', ts: 1, text: '晚上好',
      user: { id: '7', name: '阿杰', platform: 'bilibili', guardLevel: 3 },
    });
    const html = renderToStaticMarkup(<Badge user={event!.user} platform={event!.platform} />);
    expect(html).toContain('舰长');
    expect(html).not.toContain('荣誉');
  });

  it('renders Douyin gifts with their original diamond amount', () => {
    const event = toStage({
      id: 'gift-2', platform: 'douyin', kind: 'gift', ts: 1, user: douyinUser,
      giftName: '大啤酒', count: 2, diamonds: 20, valueYuan: 2,
    });
    const html = renderToStaticMarkup(<AlertCard alert={alert(event)} />);
    expect(html).toContain('共 20 抖币');
    expect(html).toContain('大啤酒');
    expect(html).toContain('×2');
    expect(html).not.toContain('¥');
  });

  it('renders Douyin fans-club membership without Bilibili ship wording or icon', () => {
    const html = renderToStaticMarkup(<AlertCard alert={alert(toStage(membership('douyin')))} />);
    expect(html).toContain('粉丝团');
    expect(html).toContain('加入了粉丝团');
    expect(html).not.toContain('欢迎上船');
    expect(html).not.toContain('开通了');
    expect(html).not.toContain('ls-guard-ship');
  });

  it('keeps the Bilibili membership card as a guard subscription', () => {
    const html = renderToStaticMarkup(<AlertCard alert={alert(toStage(membership('bilibili')))} />);
    expect(html).toContain('欢迎上船');
    expect(html).toContain('开通了舰长');
    expect(html).toContain('ls-guard-ship');
  });

  it('does not describe Douyin fans-club membership as months to the agent', () => {
    const text = topicText({
      kind: 'thanks', events: [membership('douyin')], id: 'topic-1', priority: 90, heat: 'quiet', createdAt: 1,
    }, {});
    expect(text).toContain('加入了粉丝团');
    expect(text).toContain('抖音荣誉等级37级');
    expect(text).toContain('粉丝团12级');
    expect(text).not.toContain('粉丝牌12级');
    expect(text).not.toContain('开通了粉丝团');
    expect(text).not.toContain('个月');
  });
});
