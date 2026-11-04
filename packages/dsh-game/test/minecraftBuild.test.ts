import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { buildStructure, type BuildBlock, type BuildHelpers, type BuildTemporaryBlock } from '../src/games/minecraft/body/build.js';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

function fixture(
  initial: Array<{ x: number; y: number; z: number; name: string; props?: Record<string, string> }>,
  inventory: Record<string, number> = {},
) {
  const blocks = new Map<string, any>();
  const unloaded = new Set<string>();
  const setBlock = (p: { x: number; y: number; z: number }, name: string, props: Record<string, string> = {}) => {
    const block = {
      name,
      position: new Vec3(p.x, p.y, p.z),
      boundingBox: name === 'air' ? 'empty' : 'block',
      getProperties: () => ({ ...props }),
    };
    blocks.set(key(p), block);
    return block;
  };
  for (const b of initial) setBlock(b, b.name, b.props);
  const bot: any = {
    version: '1.20.4',
    registry: {
      blocksByName: Object.fromEntries(['stone', 'dirt', 'cobblestone', 'oak_door'].map((name) => [name, {}])),
      itemsByName: Object.fromEntries(['stone', 'dirt', 'cobblestone', 'oak_door'].map((name) => [name, {}])),
    },
    entity: { position: new Vec3(0.5, 1, 0.5) },
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    heldItem: { name: 'dirt' },
    placementProperties: {} as Record<string, string>,
    pathfinder: { movements: { old: true }, setMovements: vi.fn() },
    blockAt(p: { x: number; y: number; z: number }) {
      if (unloaded.has(key(p))) return null;
      return blocks.get(key(p)) ?? {
        name: 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty', getProperties: () => ({}),
      };
    },
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }),
    look: vi.fn(async () => {}),
    waitForTicks: vi.fn(async () => {}),
  };
  bot._placeBlockWithOptions = vi.fn(async (reference: any, face: Vec3) => {
    setBlock(reference.position.plus(face), bot.heldItem.name, bot.placementProperties);
  });
  bot.placeBlock = vi.fn(async (reference: any, face: Vec3) => {
    setBlock(reference.position.plus(face), bot.heldItem.name, bot.placementProperties);
  });
  const helpers: BuildHelpers = {
    movements: () => ({ exclusionAreasBreak: [], exclusionAreasPlace: [] }),
    place: vi.fn(async (item: any, target: Vec3) => { setBlock(target, item.name); }),
    dig: vi.fn(async (target: Vec3) => { setBlock(target, 'air'); }),
    pickup: vi.fn(async () => {}),
    progress: vi.fn(),
    placed: vi.fn(),
    log: vi.fn(),
  };
  return { bot, helpers, setBlock, unloaded };
}

function block(x: number, y: number, z: number, name = 'stone', props: Record<string, string> = {}): BuildBlock {
  return { x, y, z, name, props };
}

function evidence(result: any): { completed: number; remaining: BuildBlock[]; temporaryBlocks: BuildTemporaryBlock[] } {
  return result.observations.find((o: any) => o.kind === 'build-evidence')?.data;
}

describe('通用建造器的真实状态差量', () => {
  it.each([
    ['朝向错误', { facing: 'east' }],
    ['实际属性缺失', {}],
  ])('%s不能被当成图纸完成', async (_label, actualProps) => {
    const target = block(0, 1, 0, 'oak_door', { facing: 'north' });
    const { bot, helpers } = fixture([
      { x: 0, y: 0, z: 0, name: 'stone' },
      { x: 0, y: 1, z: 0, name: 'oak_door', props: actualProps },
    ], { oak_door: 2 });
    bot.placementProperties = actualProps;

    const result = await buildStructure(bot, {
      label: 'door', blocks: [target], clear: [], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('partial');
    expect(result.summary).toContain('facing the wrong way');
    expect(helpers.placed).not.toHaveBeenCalled();
    expect(evidence(result).remaining).toEqual([target]);
  });

  it('已经名字和状态都匹配的方块直接跳过，不消耗或重放', async () => {
    const target = block(0, 1, 0);
    const { bot, helpers } = fixture([{ ...target }]);

    const result = await buildStructure(bot, {
      label: 'resume', blocks: [target], clear: [], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('succeeded');
    expect(helpers.place).not.toHaveBeenCalled();
    expect(helpers.placed).toHaveBeenCalledWith(target);
    expect(evidence(result).completed).toBe(1);
  });
});

describe('施工安全门槛与中断', () => {
  it('安全检查先于第一次破坏性清格', async () => {
    const order: string[] = [];
    const { bot, helpers, setBlock } = fixture([{ x: 0, y: 0, z: 0, name: 'stone' }]);
    helpers.secureSite = vi.fn(async () => { order.push('secure'); });
    helpers.dig = vi.fn(async (target: Vec3) => {
      order.push('dig');
      setBlock(target, 'air');
    });

    const result = await buildStructure(bot, {
      label: 'clear', blocks: [], clear: [{ x: 0, y: 0, z: 0 }], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('succeeded');
    expect(order).toEqual(['secure', 'dig']);
  });

  it('安全条件不满足时不清格，并返回可恢复的 unsafe', async () => {
    const { bot, helpers } = fixture([{ x: 0, y: 0, z: 0, name: 'stone' }]);
    helpers.secureSite = vi.fn(async () => { throw new Error('hostiles nearby'); });

    const result = await buildStructure(bot, {
      label: 'unsafe', blocks: [], clear: [{ x: 0, y: 0, z: 0 }], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('unsafe');
    expect(result.error?.recoverable).toBe(true);
    expect(helpers.dig).not.toHaveBeenCalled();
  });

  it('取消后不继续清理临时块，证据保留剩余工作', async () => {
    const target = block(0, 1, 0);
    const owned = { x: 2, y: 0, z: 0, name: 'dirt' };
    const controller = new AbortController();
    const { bot, helpers } = fixture([{ ...target }, owned], {});
    helpers.secureSite = vi.fn(async () => {
      controller.abort();
      throw new Error('interrupted');
    });

    const result = await buildStructure(bot, {
      label: 'cancel', blocks: [target], clear: [], ownedTemporary: [owned], signal: controller.signal,
    }, helpers);

    expect(result.outcome).toBe('cancelled');
    expect(helpers.dig).not.toHaveBeenCalled();
    expect(bot.blockAt(owned).name).toBe('dirt');
    expect(evidence(result).temporaryBlocks).toEqual([owned]);
  });
});

describe('临时块显式所有权', () => {
  it('只清本 job 台账里的块，不扫描并误拆旁边的玩家方块', async () => {
    const target = block(0, 1, 0);
    const owned = { x: 1, y: 0, z: 0, name: 'dirt' };
    const player = { x: 2, y: 0, z: 0, name: 'dirt' };
    const { bot, helpers } = fixture([{ ...target }, owned, player]);

    const result = await buildStructure(bot, {
      label: 'cleanup', blocks: [target], clear: [], ownedTemporary: [owned], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('succeeded');
    expect(bot.blockAt(owned).name).toBe('air');
    expect(bot.blockAt(player).name).toBe('dirt');
    expect(helpers.dig).toHaveBeenCalledOnce();
    expect(evidence(result).temporaryBlocks).toEqual([]);
  });

  it('玩家后来替换过的位置会放弃所有权，但绝不挖掉新方块', async () => {
    const target = block(0, 1, 0);
    const owned = { x: 1, y: 0, z: 0, name: 'dirt' };
    const { bot, helpers } = fixture([{ ...target }, { ...owned, name: 'stone' }]);

    const result = await buildStructure(bot, {
      label: 'replaced', blocks: [target], clear: [], ownedTemporary: [owned], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('succeeded');
    expect(bot.blockAt(owned).name).toBe('stone');
    expect(helpers.dig).not.toHaveBeenCalled();
    expect(evidence(result).temporaryBlocks).toEqual([]);
  });

  it('未加载的台账位置不猜成空气，保留证据并返回 partial', async () => {
    const target = block(0, 1, 0);
    const owned = { x: 1, y: 0, z: 0, name: 'dirt' };
    const { bot, helpers, unloaded } = fixture([{ ...target }]);
    unloaded.add(key(owned));

    const result = await buildStructure(bot, {
      label: 'unknown', blocks: [target], clear: [], ownedTemporary: [owned], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('partial');
    expect(helpers.dig).not.toHaveBeenCalled();
    expect(evidence(result).temporaryBlocks).toEqual([owned]);
  });

  it('记录 bot.placeBlock 实际垫出的脚手架，并恢复原始放置函数', async () => {
    const target = block(0, 1, 0);
    const support = { x: 1, y: 0, z: 0, name: 'dirt' };
    const { bot, helpers } = fixture([{ ...target }]);
    const originalPlaceBlock = bot.placeBlock;
    helpers.secureSite = vi.fn(async () => {
      await bot.placeBlock({ position: new Vec3(1, -1, 0) }, new Vec3(0, 1, 0));
      expect(bot.blockAt(support).name).toBe('dirt');
    });

    const result = await buildStructure(bot, {
      label: 'tracked', blocks: [target], clear: [], signal: new AbortController().signal,
    }, helpers);

    expect(result.outcome).toBe('succeeded');
    expect(bot.blockAt(support).name).toBe('air');
    expect(bot.placeBlock).toBe(originalPlaceBlock);
  });
});
