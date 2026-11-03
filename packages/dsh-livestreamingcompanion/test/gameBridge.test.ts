import { describe, expect, it, vi } from 'vitest';
import { playMinecraft, type LiveGameBody } from '../src/dsh/gameBridge';

const running = { status: 'running', game: 'minecraft', owner: 'game-line' };

describe('live Minecraft control through dsh-game', () => {
  it('starts the game as the game-line owner before handing off play', async () => {
    const start = vi.fn(async () => ({ ok: true, status: '进了服务器', briefing: '【游戏】Minecraft\n\n进了服务器', state: running }));
    const handoff = vi.fn(() => true);
    const result = await playMinecraft({
      body: { start } satisfies LiveGameBody,
      gameSession: 'game-line',
      goal: '挖一组煤',
      handoff,
    });
    expect(start).toHaveBeenCalledWith('minecraft', 'game-line');
    expect(handoff).toHaveBeenCalledOnce();
    expect(handoff.mock.calls[0][0]).toContain('【游戏】Minecraft');
    expect(handoff.mock.calls[0][0]).toContain('不要再调 game_start');
    expect(handoff.mock.calls[0][0]).toContain('挖一组煤');
    expect(result).toContain('已通过 dsh-game 启动');
  });

  it('returns the real startup failure and never claims play has started', async () => {
    const handoff = vi.fn(() => true);
    const result = await playMinecraft({
      body: {
        start: async () => ({
          ok: false,
          status: '进不了服务器：连接被拒绝',
          briefing: '进不了服务器：连接被拒绝',
          state: { status: 'none', game: null, owner: null },
        }),
      },
      gameSession: 'game-line',
      goal: '',
      handoff,
    });
    expect(result).toContain('连接被拒绝');
    expect(handoff).not.toHaveBeenCalled();
  });

  it('fails clearly when the game line or game plugin is unavailable', async () => {
    const start = vi.fn();
    expect(await playMinecraft({ body: { start }, gameSession: null, goal: '', handoff: () => true })).toContain('重新开播');
    expect(await playMinecraft({ body: undefined, gameSession: 'game-line', goal: '', handoff: () => true })).toContain('启用 dsh-game');
    expect(start).not.toHaveBeenCalled();
  });
});
