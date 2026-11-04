import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  gatherWood,
  moveAway,
  type GatherWoodProgress,
} from '../src/games/minecraft/body/gatherWood.js';

function emptyBot() {
  return {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: vi.fn(() => []),
    blockAt: vi.fn(() => null),
  };
}

describe('bounded wood gathering', () => {
  it('returns real partial progress after the total search budget instead of searching forever', async () => {
    const bot = emptyBot();
    const relocate = vi.fn(async () => false);
    const progress: GatherWoodProgress[] = [];

    const result = await gatherWood(bot, 4, 64, undefined, (entry) => progress.push(entry), {
      maxAttempts: 3,
      relocate,
    });

    expect(result).toMatchObject({ requested: 4, before: 0, after: 0, collected: 0 });
    expect(bot.findBlocks).toHaveBeenCalledTimes(3);
    expect(relocate).toHaveBeenCalledTimes(3);
    expect(progress.at(-1)).toMatchObject({ phase: 'retry', level: 'warn' });
    expect(progress.at(-1)?.message).toContain('3/3 search cycles');
  });

  it('does not treat unloaded relocation columns as safe or try random candidates forever', async () => {
    const bot = emptyBot();

    await expect(moveAway(bot, 50)).resolves.toBe(false);

    expect(bot.blockAt).toHaveBeenCalledTimes(16);
  });

  it('preserves cancellation when relocation is interrupted', async () => {
    const bot = emptyBot();
    const controller = new AbortController();
    controller.abort();

    await expect(moveAway(bot, 50, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(bot.blockAt).not.toHaveBeenCalled();
  });
});
