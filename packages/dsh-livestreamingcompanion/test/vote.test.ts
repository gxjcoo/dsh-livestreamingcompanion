import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent, LivePlatform } from '../src/core/live';
import { Stage } from '../src/body/stage';
import { ballotOption, LiveVote, voteResultText } from '../src/body/vote';
import type { StageEvent } from '../src/stage/protocol';

function chat(id: string, uid: string, text: string, platform: LivePlatform = 'bilibili'): LiveEvent {
  return { kind: 'chat', id, platform, ts: Date.now(), user: { id: uid, name: uid }, text };
}

describe('danmaku vote', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts only a whole ballot message', () => {
    expect(ballotOption('1', 3)).toBe(1);
    expect(ballotOption('选 2', 3)).toBe(2);
    expect(ballotOption('投 3 票', 3)).toBe(3);
    expect(ballotOption('２号', 3)).toBe(2);
    expect(ballotOption('我有 3 只猫', 3)).toBeNull();
    expect(ballotOption('1 2', 3)).toBeNull();
    expect(ballotOption('4', 3)).toBeNull();
    expect(ballotOption('2 号吧', 3)).toBeNull();
  });

  it('counts one vote per platform user, lets them change it, and executes only the winner', async () => {
    const stage = new Stage();
    const events: StageEvent[] = [];
    stage.subscribe((event) => events.push(event), false);
    const votes = new LiveVote(stage);
    const pending = votes.start('接下来做什么？', ['看猫猫视频', '玩游戏']);

    expect(votes.observe(chat('m0', 'u0', '我有 2 只猫'))).toBe(false);
    expect(votes.observe(chat('m1', 'u1', '1'))).toBe(true);
    expect(votes.observe(chat('m2', 'u2', '2'))).toBe(true);
    expect(votes.observe(chat('m3', 'u3', '２号'))).toBe(true);
    expect(votes.observe(chat('m4', 'u4', '选 1'))).toBe(true);
    expect(votes.observe(chat('m5', 'u1', '投 2 票'))).toBe(true);
    expect(votes.observe(chat('m6', 'u2', '2'))).toBe(true);
    // 不同平台的相同 uid 是两位观众
    expect(votes.observe(chat('m7', 'u2', '1', 'douyin'))).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.outcome).toBe('winner');
    expect(result.vote).toMatchObject({ status: 'ended', winner: 2, counts: [2, 3], tied: [] });
    expect(voteResultText(result)).toContain('现在只执行 2 号「玩游戏」');
    expect(events.filter((event) => event.type === 'vote').at(-1)).toMatchObject({ vote: { status: 'ended', winner: 2 } });

    await vi.advanceTimersByTimeAsync(4000);
    expect(events.at(-1)).toMatchObject({ type: 'vote', vote: null });
  });

  it('does not pick a winner on a tie', async () => {
    const votes = new LiveVote(new Stage());
    const pending = votes.start('选哪个？', ['第一个', '第二个', '第三个']);
    votes.observe(chat('m1', 'u1', '1'));
    votes.observe(chat('m2', 'u2', '2'));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'tie', vote: { winner: null, tied: [1, 2], counts: [1, 1, 0] } });
    expect(voteResultText(result)).toContain('不要自行挑选或执行');
  });

  it('does nothing when nobody votes', async () => {
    const votes = new LiveVote(new Stage());
    const pending = votes.start('选哪个？', ['第一个', '第二个']);
    expect(votes.observe(chat('m1', 'u1', '随便'))).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.outcome).toBe('empty');
    expect(voteResultText(result)).toContain('不要执行任何一个候选要求');
  });

  it('cancels the popup and releases the waiting tool when the show stops', async () => {
    const stage = new Stage();
    const events: StageEvent[] = [];
    stage.subscribe((event) => events.push(event), false);
    const votes = new LiveVote(stage);
    const pending = votes.start('选哪个？', ['第一个', '第二个']);
    votes.cancel();
    expect((await pending).outcome).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ type: 'vote', vote: null });
  });
});
