import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameBody } from '../src/liveBridge';
import { games, type GameState } from '../src/runtime';

const state = (status: GameState['status'], owner: string | null): GameState => ({
  status,
  game: status === 'none' ? null : 'minecraft',
  title: status === 'none' ? null : 'Minecraft',
  owner,
  closed: null,
});

afterEach(() => vi.restoreAllMocks());

describe('gameBody service', () => {
  it('reports success only for the requested game and owner', async () => {
    vi.spyOn(games, 'start').mockResolvedValue('进了服务器');
    vi.spyOn(games, 'session', 'get').mockReturnValue({ facts: '【游戏】Minecraft' } as any);
    const stateSpy = vi.spyOn(games, 'state');
    stateSpy.mockReturnValue(state('running', 'game-line'));
    await expect(gameBody.start('minecraft', 'game-line')).resolves.toMatchObject({ ok: true, status: '进了服务器', briefing: '【游戏】Minecraft\n\n进了服务器' });
    expect(games.start).toHaveBeenCalledWith('minecraft', 'game-line');

    stateSpy.mockReturnValue(state('running', 'another-session'));
    await expect(gameBody.start('minecraft', 'game-line')).resolves.toMatchObject({ ok: false });
  });

  it('passes a failed startup state back to the caller', async () => {
    vi.spyOn(games, 'start').mockResolvedValue('进不了服务器');
    vi.spyOn(games, 'state').mockReturnValue(state('none', null));
    await expect(gameBody.start('minecraft', 'game-line')).resolves.toMatchObject({ ok: false, status: '进不了服务器' });
  });
});
