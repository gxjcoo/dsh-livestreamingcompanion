import { describe, expect, it } from 'vitest';
import { MinecraftEmbodimentRuntime } from '../src/games/minecraft/body/embodimentRuntime.js';
import type { MinecraftActionResult } from '../src/games/minecraft/body/contracts.js';

function result(overrides: Partial<MinecraftActionResult> = {}): MinecraftActionResult {
  return {
    actionId: '', outcome: 'succeeded', summary: 'done', durationMs: 1,
    inventoryDelta: {}, worldChanges: [], observations: [], ...overrides,
  };
}

function runtime(craftItem: () => Promise<MinecraftActionResult>): MinecraftEmbodimentRuntime {
  return new MinecraftEmbodimentRuntime({
    now: () => 100,
    adapter: {
      isConnected: () => true,
      closeStrayWindow: async () => undefined,
      craftItem,
    } as any,
  });
}

const instruction = { id: 'craft-1', name: 'craft_item' as const, args: { item: 'torch', quantity: 1 } };

describe('top-level action result certainty', () => {
  it('adds a certain envelope to a fully returned legacy action result', async () => {
    const response = await runtime(async () => result()).execute(instruction);
    expect(response).toMatchObject({ actionId: 'craft-1', outcome: 'succeeded', certainty: 'certain' });
  });

  it('marks an exception after a non-idempotent handler started as uncertain', async () => {
    const response = await runtime(async () => { throw new Error('connection lost after crafting'); }).execute(instruction);
    expect(response).toMatchObject({
      outcome: 'failed', certainty: 'uncertain', error: { code: 'adapter_error', recoverable: true },
    });
  });

  it('preserves a handler-specific uncertain declaration even without a generic timeout code', async () => {
    const response = await runtime(async () => result({
      outcome: 'partial', certainty: 'uncertain',
      error: { code: 'missing_item', recoverable: true, details: { item: 'coal' } },
    })).execute(instruction);
    expect(response).toMatchObject({ outcome: 'partial', certainty: 'uncertain', error: { code: 'missing_item' } });
  });
});
