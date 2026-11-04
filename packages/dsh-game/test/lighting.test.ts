import { describe, expect, it } from 'vitest';
import {
  ensureLighting,
  inspectTorchTarget,
  minimumSpawnSafeBlockLight,
  needsLighting,
  sampleLighting,
  scanTorchCandidates,
  waitForTorch,
  type LightingPosition,
  type TorchCandidate,
} from '../src/games/minecraft/body/lighting.js';
import { buildMinecraftSnapshot } from '../src/games/minecraft/body/perception.js';

function key(position: LightingPosition): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function fakeWorld(initial: Array<[LightingPosition, any]> = []) {
  const blocks = new Map<string, any>();
  const bot: any = {
    version: '1.20.4',
    registry: { blocksByName: { torch: {}, wall_torch: {} } },
    world: { maxY: 66 },
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    inventory: { items: () => [] },
    blockAt(position: LightingPosition) {
      return blocks.get(key(position)) ?? null;
    },
  };
  const set = (position: LightingPosition, block: any) => {
    block.position = { ...position };
    blocks.set(key(position), block);
    return block;
  };
  for (const [position, block] of initial) set(position, block);
  return { bot, blocks, set };
}

function block(name: string, light = 0, skyLight = 0, extra: Record<string, unknown> = {}) {
  return {
    name,
    light,
    skyLight,
    transparent: name === 'air',
    boundingBox: name === 'air' ? 'empty' : 'block',
    getProperties: () => ({}),
    ...extra,
  };
}

function air(light = 0, skyLight = 0) {
  return block('air', light, skyLight, { transparent: true, boundingBox: 'empty' });
}

function stone() {
  return block('stone', 0, 0, { transparent: false, boundingBox: 'block' });
}

const target = { x: 0, y: 64, z: 0 };
const modernSpawnPolicy = {
  policy: 'spawn-risk' as const,
  dimension: 'minecraft:overworld',
  version: '1.20.4',
};

function scanOptions(extra: Record<string, unknown> = {}) {
  return {
    ...modernSpawnPolicy,
    center: target,
    radius: 0,
    verticalRadius: 0,
    ...extra,
  };
}

describe('loaded-aware lighting samples', () => {
  it('reads real block and sky light and verifies an open loaded column', () => {
    const { bot } = fakeWorld([
      [target, air(3, 15)],
      [{ x: 0, y: 65, z: 0 }, air(0, 15)],
      [{ x: 0, y: 66, z: 0 }, air(0, 15)],
    ]);
    expect(sampleLighting(bot, { x: 0.8, y: 64.2, z: 0.1 }, 1234)).toEqual({
      loaded: true,
      blockLight: 3,
      skyLight: 15,
      canSeeSky: true,
      sampledAt: 1234,
    });
  });

  it('distinguishes an opaque roof from an unloaded column above', () => {
    const covered = fakeWorld([
      [target, air(2, 0)],
      [{ x: 0, y: 65, z: 0 }, stone()],
    ]);
    expect(sampleLighting(covered.bot, target).canSeeSky).toBe(false);

    const unknown = fakeWorld([[target, air(2, 0)]]);
    const sample = sampleLighting(unknown.bot, target);
    expect(sample.loaded).toBe(true);
    expect(sample.blockLight).toBe(2);
    expect(sample.canSeeSky).toBeNull();
  });

  it('returns unknown values when blockAt is null', () => {
    const { bot } = fakeWorld();
    expect(sampleLighting(bot, target, 99)).toEqual({
      loaded: false,
      blockLight: null,
      skyLight: null,
      canSeeSky: null,
      sampledAt: 99,
    });
  });

  it('keeps lighting in connected snapshots and removes it when disconnected', () => {
    const lighting = { loaded: false, blockLight: null, skyLight: null, canSeeSky: null, sampledAt: 10 };
    const raw = {
      capturedAt: 10,
      connection: { connected: true },
      lighting,
      nearbyBlocks: [],
      nearbyEntities: [],
      recentEvents: [],
    };
    expect(buildMinecraftSnapshot(raw).lighting).toEqual(lighting);
    expect(buildMinecraftSnapshot({ ...raw, connection: { connected: false } }).lighting).toBeUndefined();
  });
});

describe('visibility and spawn-risk policy', () => {
  it('uses the modern Overworld block-light zero rule, independently of sky light', () => {
    expect(minimumSpawnSafeBlockLight('overworld', '1.20.4')).toBe(1);
    expect(needsLighting({ loaded: true, blockLight: 0, skyLight: 15 }, modernSpawnPolicy)).toBe(true);
    expect(needsLighting({ loaded: true, blockLight: 1, skyLight: 15 }, modernSpawnPolicy)).toBe(false);
  });

  it('uses legacy, Nether, and End rules without a universal threshold', () => {
    expect(minimumSpawnSafeBlockLight('overworld', '1.12.2')).toBe(8);
    expect(minimumSpawnSafeBlockLight('the_nether', '1.20.4')).toBe(12);
    expect(minimumSpawnSafeBlockLight('the_end', '1.20.4')).toBe(8);
    expect(needsLighting(
      { loaded: true, blockLight: 7, skyLight: 0 },
      { ...modernSpawnPolicy, version: '1.12.2' },
    )).toBe(true);
    expect(needsLighting(
      { loaded: true, blockLight: 11, skyLight: 0 },
      { ...modernSpawnPolicy, dimension: 'the_nether' },
    )).toBe(true);
  });

  it('uses sky light only for daytime visibility, never to mask spawn risk', () => {
    const sample = { loaded: true, blockLight: 2, skyLight: 15 };
    expect(needsLighting(sample, { policy: 'visibility', timeOfDay: 1000 })).toBe(false);
    expect(needsLighting(sample, { policy: 'visibility', timeOfDay: 13_000 })).toBe(true);
    expect(needsLighting({ ...sample, blockLight: 7 }, { policy: 'visibility', timeOfDay: 13_000 })).toBe(false);
  });

  it('does not interpret unknown light as darkness', () => {
    expect(needsLighting({ loaded: false, blockLight: null, skyLight: null }, modernSpawnPolicy)).toBeNull();
  });
});

describe('torch candidates and exact target state', () => {
  it('prefers exact floor support directly below the target', () => {
    const { bot } = fakeWorld([
      [target, air()],
      [{ x: 0, y: 63, z: 0 }, stone()],
    ]);
    const scan = scanTorchCandidates(bot, scanOptions());
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      kind: 'floor',
      face: 'top',
      expectedName: 'torch',
      support: { x: 0, y: 63, z: 0 },
    });
  });

  it('uses a cardinal wall and derives wall_torch facing from its support', () => {
    const { bot } = fakeWorld([
      [target, air()],
      [{ x: 0, y: 63, z: 0 }, air()],
      [{ x: 0, y: 64, z: 1 }, stone()],
    ]);
    const candidate = scanTorchCandidates(bot, scanOptions()).candidates[0];
    expect(candidate).toMatchObject({
      kind: 'wall',
      face: 'north',
      expectedFacing: 'north',
      expectedName: 'wall_torch',
      support: { x: 0, y: 64, z: 1 },
    });

    bot.blockAt = (position: LightingPosition) => key(position) === key(target)
      ? block('wall_torch', 14, 0, {
          transparent: true,
          boundingBox: 'empty',
          getProperties: () => ({ facing: 'south' }),
        })
      : null;
    expect(inspectTorchTarget(bot, candidate).matches).toBe(false);
    bot.blockAt = (position: LightingPosition) => key(position) === key(target)
      ? block('wall_torch', 14, 0, {
          transparent: true,
          boundingBox: 'empty',
          getProperties: () => ({ facing: 'north' }),
        })
      : null;
    expect(inspectTorchTarget(bot, candidate).matches).toBe(true);
  });

  it('never places into a protected cell', () => {
    const { bot } = fakeWorld([
      [target, air()],
      [{ x: 0, y: 63, z: 0 }, stone()],
    ]);
    const scan = scanTorchCandidates(bot, scanOptions({ protectedCells: [target] }));
    expect(scan.candidates).toEqual([]);
    expect(scan.protectedPositions).toEqual([target]);
    expect(scan.darkPositions).toEqual([target]);
  });

  it('separates unloaded cells from known cells without support', () => {
    const unloaded = fakeWorld();
    expect(scanTorchCandidates(unloaded.bot, scanOptions())).toMatchObject({
      candidates: [],
      unknownPositions: [target],
      unsupportedPositions: [],
    });

    const unsupported = fakeWorld([
      [target, air()],
      [{ x: 0, y: 63, z: 0 }, air()],
      [{ x: 0, y: 64, z: -1 }, air()],
      [{ x: 0, y: 64, z: 1 }, air()],
      [{ x: 1, y: 64, z: 0 }, air()],
      [{ x: -1, y: 64, z: 0 }, air()],
    ]);
    expect(scanTorchCandidates(unsupported.bot, scanOptions())).toMatchObject({
      candidates: [],
      unknownPositions: [],
      unsupportedPositions: [target],
    });
  });
});

describe('bounded lighting execution', () => {
  function wallCandidate(): TorchCandidate {
    return {
      target,
      support: { x: 0, y: 64, z: 1 },
      kind: 'wall',
      face: 'north',
      expectedName: 'wall_torch',
      expectedFacing: 'north',
      blockLight: 0,
      distance: 0,
    };
  }

  it('polls until the exact block and its real light update arrive', async () => {
    const candidate = wallCandidate();
    const { bot, set } = fakeWorld([[target, air()]]);
    let sleeps = 0;
    const verified = await waitForTorch(bot, candidate, modernSpawnPolicy, {
      polls: 3,
      intervalMs: 0,
      sleep: async () => {
        sleeps += 1;
        set(target, block('wall_torch', 14, 0, {
          transparent: true,
          boundingBox: 'empty',
          getProperties: () => ({ facing: 'north' }),
        }));
      },
    });
    expect(verified.ok).toBe(true);
    expect(sleeps).toBe(1);
  });

  it('returns unknown after bounded polling if the target unloads', async () => {
    const { bot } = fakeWorld();
    const verified = await waitForTorch(bot, wallCandidate(), modernSpawnPolicy, {
      polls: 2,
      intervalMs: 0,
      sleep: async () => undefined,
    });
    expect(verified).toMatchObject({ ok: false, code: 'unknown', reason: 'target_unloaded' });
  });

  it('returns missing_item without crafting or invoking placement', async () => {
    const { bot } = fakeWorld([
      [target, air()],
      [{ x: 0, y: 63, z: 0 }, stone()],
    ]);
    let placed = 0;
    const result = await ensureLighting(bot, {
      ...modernSpawnPolicy,
      radius: 0,
      verticalRadius: 0,
      maxTorches: 1,
      signal: new AbortController().signal,
      place: async () => { placed += 1; },
    });
    expect(placed).toBe(0);
    expect(result).toMatchObject({
      outcome: 'failed',
      error: { code: 'missing_item', details: { missing: { torch: 1 } } },
    });
  });

  it('uses an available torch and rescans before reporting success', async () => {
    const { bot, set } = fakeWorld([
      [target, air()],
      [{ x: 0, y: 63, z: 0 }, stone()],
    ]);
    let torches = 1;
    bot.inventory.items = () => torches > 0 ? [{ name: 'torch', count: torches }] : [];
    const result = await ensureLighting(bot, {
      ...modernSpawnPolicy,
      radius: 0,
      verticalRadius: 0,
      maxTorches: 1,
      signal: new AbortController().signal,
      place: async (_item, candidate) => {
        torches -= 1;
        set(candidate.target, block('torch', 14, 0, { transparent: true, boundingBox: 'empty' }));
      },
    });
    expect(result).toMatchObject({
      outcome: 'succeeded',
      inventoryDelta: { torch: -1 },
      worldChanges: [{ kind: 'block_placed', name: 'torch', position: target, count: 1 }],
    });
    expect(result.observations[0]).toMatchObject({
      kind: 'lighting-evidence',
      data: { samples: [{ ...target, dimension: 'overworld', loaded: true, blockLight: 14 }] },
    });
  });
});
