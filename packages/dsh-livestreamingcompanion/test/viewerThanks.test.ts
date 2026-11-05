import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';
import type { LiveEvent } from '../src/core/live';

const user = (id: string, name = `观众${id}`) => ({ id, name });
const action = (id: string, kind: 'like' | 'share' | 'follow', uid = id, count?: number): LiveEvent => ({
  id, platform: 'bilibili', kind, ts: Date.now(), user: user(uid), ...(count === undefined ? {} : { count }),
});
const gift = (id: string, valueYuan = 0): LiveEvent => ({
  id, platform: 'bilibili', kind: 'gift', ts: Date.now(), user: user(id), giftName: '小心心', count: 1, valueYuan,
});

describe('viewer support reaches the shared microphone', () => {
  afterEach(() => vi.useRealTimers());

  function start(gameSession = false, synthesize: () => Promise<null> = async () => null) {
    vi.useFakeTimers();
    const pushed: Array<{ session: string; text: string; midTurn: boolean }> = [];
    const said: string[] = [];
    const show = new LiveShow(
      { push: async (session, text, midTurn) => { pushed.push({ session, text, midTurn: !!midTurn }); return true; }, synthesize },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-viewer-thanks-')), names: ['大肥鱼'] },
    );
    show.stage.subscribe((event) => { if (event.type === 'say') said.push(event.text); }, false);
    show.goLive('live', gameSession ? 'game' : undefined);
    return { show, pushed, said };
  }

  async function opening(show: LiveShow): Promise<void> {
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
  }

  it('thanks likes, shares and gifts deterministically without a model push', async () => {
    const { show, pushed, said } = start();
    await opening(show);
    show.inject(action('like-1', 'like', '小明', 12));
    show.inject(action('like-1', 'like', '小明', 12)); // 同 id 重播不重复计数
    show.inject(action('share-1', 'share', '小红'));
    show.inject(gift('big', 10));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(pushed).toHaveLength(1); // 只有开场；感谢没有再交给模型
    expect(said.some((text) => text.includes('小心心'))).toBe(true);
    expect(said.some((text) => text.includes('小明点的12个赞'))).toBe(true);
    expect(said.some((text) => text.includes('小红分享直播'))).toBe(true);
    expect(said.some((text) => text.includes('24个赞'))).toBe(false);
    show.dispose();
  });

  it('also delivers free-gift, membership and follow thanks', async () => {
    const { show, pushed, said } = start();
    await opening(show);
    show.inject(gift('free'));
    show.inject({ id: 'member', platform: 'douyin', kind: 'membership', ts: Date.now(), user: user('会员'), levelName: '粉丝团', level: 1, count: 1, valueYuan: 0 });
    show.inject(action('follow', 'follow', '新粉'));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(said.some((text) => text.includes('粉丝团'))).toBe(true);
    expect(said.some((text) => text.includes('小心心'))).toBe(true);
    expect(said.some((text) => text.includes('新粉') && text.includes('关注'))).toBe(true);
    expect(pushed).toHaveLength(1);
    show.dispose();
  });

  it('coalesces a like storm into one bounded utterance', async () => {
    const { show, pushed, said } = start();
    await opening(show);
    for (let index = 0; index < 2_000; index += 1) show.inject(action(`like-${index}`, 'like', `u${index % 100}`));
    await vi.advanceTimersByTimeAsync(20_000);
    const likes = said.filter((text) => text.includes('赞'));
    expect(likes).toHaveLength(1);
    expect(likes[0]).toContain('其他朋友');
    expect(pushed).toHaveLength(1);
    show.dispose();
  });

  it('keeps game speech and deterministic thanks in FIFO order', async () => {
    const { show, said } = start();
    await opening(show);
    const signal = new AbortController().signal;
    const gameLine = '这是一句很长很长的游戏解说，需要先念完，后面的感谢不能插到它前面去。';
    void show.say(gameLine, 'talk', signal, 'game');
    show.inject(action('like', 'like', '小明', 3));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(said[0]).toBe(gameLine);
    expect(said[1]).toContain('小明点的3个赞');
    show.dispose();
  });

  it('does not wake the legacy same-session game planner', async () => {
    const { show, pushed, said } = start();
    await opening(show);
    show.showGame({ window: 'Minecraft:GLFW30:javaw.exe' });
    show.turnStarted('live');
    let woke = false;
    void show.waitAttention(new AbortController().signal).then(() => { woke = true; });
    show.inject(action('like', 'like', '小明', 2));
    show.inject(action('share', 'share', '小红'));
    show.inject(gift('free'));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(woke).toBe(false);
    expect(pushed).toHaveLength(1);
    expect(said.some((text) => text.includes('赞'))).toBe(true);
    expect(said.some((text) => text.includes('小心心'))).toBe(true);
    show.dispose();
  });

  it('does not push viewer support into a separate game session', async () => {
    const { show, pushed, said } = start(true);
    await opening(show);
    let woke = false;
    void show.waitAttention(new AbortController().signal).then(() => { woke = true; });
    show.inject(action('like', 'like', '小明', 2));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pushed.filter((entry) => entry.session === 'game')).toEqual([]);
    expect(pushed).toHaveLength(1);
    expect(woke).toBe(false);
    expect(said.some((text) => text.includes('小明点的2个赞'))).toBe(true);
    show.dispose();
  });

  it('does not emit pending thanks after dispose', async () => {
    const { show, said } = start();
    await opening(show);
    show.inject(action('like', 'like'));
    show.dispose();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(said).toEqual([]);
  });

  it('does not broadcast an old-session thanks when dispose happens during synthesis', async () => {
    let finishSynthesis: (() => void) | undefined;
    const synthesis = new Promise<null>((resolve) => { finishSynthesis = () => resolve(null); });
    const { show, said } = start(false, () => synthesis);
    await opening(show);
    show.inject(action('like', 'like'));
    await vi.advanceTimersByTimeAsync(3_200);
    show.dispose();
    finishSynthesis?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(said).toEqual([]);
  });
});
