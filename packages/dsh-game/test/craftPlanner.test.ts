import { describe, expect, it } from 'vitest';
import {
  planCraft,
  smeltInputFor,
  smeltInputsFor,
  smeltOutputFor,
  SMELT_FUEL_ITEM,
  SMELT_ITEMS_PER_FUEL,
} from '../src/games/minecraft/body/craftPlanner.js';

/**
 * 最小 registry：只要 itemsByName 就够了，smelt* 系列不碰 bot 状态。
 * 这些用例锁的是「熔炼映射 + 原料挑选」这两块纯逻辑——改采集策略时最容易碰坏的地方。
 */
const registry = {
  itemsByName: {
    iron_ingot: { id: 1 },
    raw_iron: { id: 2 },
    iron_ore: { id: 3 },
    deepslate_iron_ore: { id: 4 },
    coal: { id: 5 },
    glass: { id: 6 },
    sand: { id: 7 },
    stone: { id: 8 },
    cobblestone: { id: 9 },
  },
  recipes: {},
};

describe('熔炼映射', () => {
  it('铁锭认得三种原料，且保持优先级顺序', () => {
    expect(smeltInputsFor(registry, 1)).toEqual([2, 3, 4]);
  });

  it('反查：粗铁能熔成铁锭', () => {
    expect(smeltOutputFor(registry, 2)).toBe(1);
  });

  it('玻璃来自沙子，石头来自圆石', () => {
    expect(smeltInputsFor(registry, 6)).toEqual([7]);
    expect(smeltInputsFor(registry, 8)).toEqual([9]);
  });

  it('不认识的东西返回空列表，不抛错', () => {
    expect(smeltInputsFor(registry, 5)).toEqual([]);
    expect(smeltOutputFor(registry, 5)).toBeUndefined();
  });
});

describe('熔炼原料挑选', () => {
  it('优先选库存够的那一种', () => {
    // 铁矿石有 5 个，够 2 个的用量
    const picked = smeltInputFor(registry, 1, undefined, new Map([['iron_ore', 5]]), 2);
    expect(picked).toBe(3);
  });

  it('都不够用量时，挑库存最多的', () => {
    const picked = smeltInputFor(registry, 1, undefined, new Map([['raw_iron', 1], ['deepslate_iron_ore', 3]]), 10);
    expect(picked).toBe(4);
  });

  it('全都没库存时，退回第一候选', () => {
    expect(smeltInputFor(registry, 1, undefined, new Map(), 1)).toBe(2);
  });
});

describe('planCraft 兜底', () => {
  it('不认识的物品返回稳定空计划，不炸', () => {
    const bot = { registry: { itemsByName: {} } } as any;
    const plan = planCraft(bot, 'not_a_real_item', 3);
    expect(plan.steps).toEqual([]);
    expect(plan.recipeAvailable).toBe(false);
    expect(plan.targetAmount).toBe(3);
  });
});

describe('熔炼常量', () => {
  it('燃料是煤，一块烧 8 个', () => {
    expect(SMELT_FUEL_ITEM).toBe('coal');
    expect(SMELT_ITEMS_PER_FUEL).toBe(8);
  });
});
