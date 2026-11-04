import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { secureBuildSite, type BuildSiteSafetyHooks } from '../src/games/minecraft/body/buildSite.js';
import type { BuildSite } from '../src/games/minecraft/body/build.js';
import type { MinecraftActionResult } from '../src/games/minecraft/body/contracts.js';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

function lightingResult(outcome: MinecraftActionResult['outcome'] = 'succeeded', code?: any): MinecraftActionResult {
  return {
    actionId: 'light', outcome, summary: outcome === 'succeeded' ? 'lighting secured' : 'torch missing',
    durationMs: 1, inventoryDelta: {}, worldChanges: [], observations: [],
    ...(code ? { error: { code, recoverable: true, details: { missing: { torch: 1 } } } } : {}),
  };
}

function fixture() {
  const blocks = new Map<string, any>();
  const unloaded = new Set<string>();
  const set = (p: { x: number; y: number; z: number }, name: string, extra: Record<string, unknown> = {}) => {
    const value = {
      name, position: new Vec3(p.x, p.y, p.z),
      boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block',
      light: name === 'air' ? 15 : 0, skyLight: name === 'air' ? 15 : 0,
      transparent: name !== 'stone', getProperties: () => ({}), ...extra,
    };
    blocks.set(key(p), value);
    return value;
  };
  set({ x: 0, y: 64, z: 0 }, 'stone');
  const bot: any = {
    version: '1.20.4', game: { dimension: 'minecraft:overworld' }, time: { timeOfDay: 13_000 },
    world: { maxY: 66 }, health: 20, food: 20,
    entity: { position: new Vec3(0.5, 65, 0.5) },
    registry: { foodsByName: {} }, inventory: { items: () => [] },
    blockAt(p: { x: number; y: number; z: number }) {
      if (unloaded.has(key(p))) return null;
      return blocks.get(key(p)) ?? set(p, 'air');
    },
  };
  const hooks: BuildSiteSafetyHooks = {
    hostiles: vi.fn(() => []),
    navigate: vi.fn(async () => ({ ok: true })),
    ensureLighting: vi.fn(async () => lightingResult()),
    equipWeapon: vi.fn(async () => 'stone_sword'),
    log: vi.fn(),
  };
  return { bot, hooks, set, unloaded };
}

function site(overrides: Partial<BuildSite> = {}): BuildSite {
  const blocks = [{ x: 0, y: 64, z: 0, name: 'stone', props: {} }];
  const clear: { x: number; y: number; z: number }[] = [];
  return {
    blocks, clear,
    min: { x: -2, y: 63, z: -2 }, max: { x: 2, y: 66, z: 2 },
    protectedCells: new Set([...blocks, ...clear].map(key)),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('通用施工安全门槛', () => {
  it('进场后核对区块和撤退格，再做受图纸保护的照明', async () => {
    const { bot, hooks } = fixture();
    const report = await secureBuildSite(bot, site(), hooks);
    expect(hooks.equipWeapon).toHaveBeenCalledOnce();
    expect(hooks.navigate).toHaveBeenCalledOnce();
    expect(hooks.ensureLighting).toHaveBeenCalledWith([{ x: 0, y: 64, z: 0 }], expect.any(AbortSignal));
    expect(report.retreat).toEqual({ x: 0, y: 65, z: 0 });
    expect(report.checkedCells).toBe(1);
  });

  it('有敌人时在移动和施工前阻塞，并给出防御证据', async () => {
    const { bot, hooks } = fixture();
    hooks.hostiles = () => [{ name: 'zombie', type: 'mob', hostile: true, distance: 4, position: { x: 2, y: 65, z: 0 } }];
    await expect(secureBuildSite(bot, site(), hooks)).rejects.toMatchObject({
      code: 'unsafe', details: { requirement: 'clear-hostiles' },
    });
    expect(hooks.navigate).not.toHaveBeenCalled();
    expect(hooks.ensureLighting).not.toHaveBeenCalled();
  });

  it('没有防身武器时交给上层补给，不硬开工', async () => {
    const { bot, hooks } = fixture();
    hooks.equipWeapon = async () => null;
    await expect(secureBuildSite(bot, site(), hooks)).rejects.toMatchObject({
      code: 'unsafe', details: { requirement: 'weapon' },
    });
  });

  it('未加载图纸格是 unknown，不会当成空气或黑暗', async () => {
    const { bot, hooks, unloaded } = fixture();
    unloaded.add('0,64,0');
    await expect(secureBuildSite(bot, site(), hooks)).rejects.toMatchObject({
      code: 'unknown', details: { requirement: 'loaded' },
    });
    expect(hooks.ensureLighting).not.toHaveBeenCalled();
  });

  it('清格会打开水源时在真正破坏前拒绝', async () => {
    const { bot, hooks, set } = fixture();
    set({ x: 1, y: 64, z: 0 }, 'stone');
    set({ x: 1, y: 65, z: 0 }, 'water');
    const request = site({ clear: [{ x: 1, y: 64, z: 0 }] });
    request.protectedCells = new Set([...request.blocks, ...request.clear].map(key));
    await expect(secureBuildSite(bot, request, hooks)).rejects.toMatchObject({
      code: 'unsafe', details: { requirement: 'fluid-safety', liquid: 'water' },
    });
    expect(hooks.ensureLighting).not.toHaveBeenCalled();
  });

  it('入口走不过去时保留 path_unreachable，不混成材料不足', async () => {
    const { bot, hooks } = fixture();
    hooks.navigate = async () => ({ ok: false, reason: 'noPath', message: 'sealed' });
    await expect(secureBuildSite(bot, site(), hooks)).rejects.toMatchObject({
      code: 'path_unreachable', details: { requirement: 'entrance' },
    });
  });

  it('黑暗且没有火把时返回 missing_item，由 session 决定补给', async () => {
    const { bot, hooks, set } = fixture();
    set({ x: 0, y: 65, z: 0 }, 'air', { light: 0, skyLight: 0 });
    hooks.ensureLighting = async () => lightingResult('failed', 'missing_item');
    await expect(secureBuildSite(bot, site(), hooks)).rejects.toMatchObject({
      code: 'missing_item', details: { requirement: 'lighting', stillDark: true },
    });
  });

  it('周边仍有受保护暗格但入口已安全时，记录跳过原因而不无限点火把', async () => {
    const { bot, hooks } = fixture();
    hooks.ensureLighting = async () => lightingResult('partial', 'blocked');
    const report = await secureBuildSite(bot, site(), hooks);
    expect(report.skipped).toHaveLength(1);
    expect(hooks.log).toHaveBeenCalledOnce();
  });
});
