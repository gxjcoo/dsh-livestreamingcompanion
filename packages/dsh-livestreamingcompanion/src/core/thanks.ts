/**
 * 纯支持事件的确定性台词：感谢必须真的说出口，不能只靠模型遵守提示。
 * 这里只使用平台事件里已有的名字和数量；价格、房间累计数和推算数量都不念。
 */

import { cleanName } from './safety';
import type { LiveGiftEvent, LiveUser } from './live';
import type { SupportEntry, Topic } from './attention/topics';

const name = (user: LiveUser): string => cleanName(user.name || user.id);
const times = (count: number): string => count > 1 ? `×${count}` : '';

function giftName(gift: LiveGiftEvent): string {
  return `${cleanName(gift.giftName)}${times(gift.count)}`;
}

function sentence(parts: string[], overflow = false, suffix = '支持'): string {
  const tail = overflow ? `${parts.length ? '，也' : ''}谢谢其他朋友的${suffix}` : '';
  if (!parts.length) return tail ? `${tail}！` : '';
  return `谢谢${parts.join('、')}${tail}！`;
}

/** 返回 null 表示这不是纯感谢话题，仍应交给直播模型处理（例如醒目留言正文）。 */
export function thanksText(topic: Topic): string | null {
  switch (topic.kind) {
    case 'thanks': {
      const parts = topic.events.slice(0, 3).map((event) => {
        if (event.kind === 'gift') return `${name(event.user)}送的${giftName(event)}`;
        const action = event.platform === 'douyin' ? '加入' : '开通';
        const unit = event.platform === 'douyin' ? '' : '个月';
        return `${name(event.user)}${action}的${cleanName(event.levelName)}${event.count > 1 ? `×${event.count}${unit}` : ''}`;
      });
      return sentence(parts, topic.events.length > 3);
    }
    case 'gifts': {
      const byUser = new Map<string, { user: LiveUser; gifts: LiveGiftEvent[] }>();
      for (const gift of topic.events) {
        const key = gift.user.id || gift.user.name;
        const entry = byUser.get(key) ?? { user: gift.user, gifts: [] };
        entry.gifts.push(gift);
        byUser.set(key, entry);
      }
      const parts = [...byUser.values()].slice(0, 3).map(({ user, gifts }) => {
        const details = gifts.slice(0, 2).map(giftName).join('、');
        return `${name(user)}送的${details}${gifts.length > 2 ? '等礼物' : ''}`;
      });
      return sentence(parts, topic.more > 0 || byUser.size > 3, '礼物');
    }
    case 'follow': {
      const parts = topic.users.slice(0, 3).map((user) => name(user));
      if (!parts.length) return '谢谢大家的关注！';
      return `谢谢${parts.join('、')}${topic.more > 0 || topic.users.length > 3 ? '和其他朋友' : ''}的关注！`;
    }
    case 'support': {
      const like = (entry: SupportEntry) => `${name(entry.user)}点的${entry.count > 1 ? `${entry.count}个` : ''}赞`;
      const share = (entry: SupportEntry) => `${name(entry.user)}${entry.count > 1 ? `的${entry.count}次分享` : '分享直播'}`;
      const parts = [...topic.likes.slice(0, 3).map(like), ...topic.shares.slice(0, 3).map(share)];
      return sentence(parts, topic.overflow || topic.likes.length > 3 || topic.shares.length > 3, '点赞和分享');
    }
    default:
      return null;
  }
}
