import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinecraftSession } from '../src/games/minecraft/session';
import { MinecraftRuntimeManager } from '../src/games/minecraft/body/runtimeManager';

afterEach(() => vi.restoreAllMocks());

describe('Minecraft startup state', () => {
  it('does not count a rejected server connection as a running game', async () => {
    vi.spyOn(MinecraftRuntimeManager.prototype, 'command').mockRejectedValue(new Error('connection refused'));
    const session = new MinecraftSession({
      workerPath: 'unused-in-test',
      host: '127.0.0.1',
      port: 25565,
      username: 'DaFeiYu',
      record: () => {},
      camera: null,
      journalDir: null,
    });
    await expect(session.start()).resolves.toContain('进不了服务器');
    expect(session.started).toBe(false);
    await session.stop();
  });
});
