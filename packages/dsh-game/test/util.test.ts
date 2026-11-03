import { describe, expect, it } from 'vitest';
import {
  armorPoints,
  clearPathfinderGoal,
  compareVersionParts,
  delay,
  distanceBetween,
  formatPosition,
  numericVersionParts,
  relativeDirection,
} from '../src/games/minecraft/body/util.js';

/**
 * util.ts 是从 4000 行的 mineflayerAdapter 里抽出来的纯函数层。
 * 这些用例的作用是：以后继续往下拆时，一改就立刻知道有没有动坏。
 */
describe('坐标格式化', () => {
  it('整数坐标不带小数', () => {
    expect(formatPosition({ x: 12, y: 64, z: -3 })).toBe('12,64,-3');
  });

  it('缺字段按 0 处理', () => {
    expect(formatPosition({ x: 5 })).toBe('5,0,0');
  });
});

describe('距离', () => {
  it('三维直线距离', () => {
    expect(distanceBetween({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
  });
});

describe('方位', () => {
  const bot = { entity: { position: { x: 0, y: 0, z: 0 } } };

  it('东南西北按 Minecraft 的 z 轴方向算', () => {
    expect(relativeDirection(bot, { x: 10, y: 0, z: 0 })).toBe('east');
    expect(relativeDirection(bot, { x: 0, y: 0, z: -10 })).toBe('north');
    expect(relativeDirection(bot, { x: 10, y: 0, z: -10 })).toBe('north-east');
  });

  it('贴着身边时是 nearby', () => {
    expect(relativeDirection(bot, { x: 0.2, y: 0, z: 0 })).toBe('nearby');
  });
});

describe('版本号比较', () => {
  it('逐段比较，短的一方补 0', () => {
    expect(compareVersionParts([1, 21, 9], [1, 21, 8])).toBeGreaterThan(0);
    expect(compareVersionParts([1, 21], [1, 21, 0])).toBe(0);
    expect(compareVersionParts([26, 1], [1, 21, 9])).toBeGreaterThan(0);
  });

  it('只接受纯数字点号分隔', () => {
    expect(numericVersionParts('1.21.9')).toEqual([1, 21, 9]);
    expect(numericVersionParts('1.21-pre1')).toBeUndefined();
    expect(numericVersionParts('')).toBeUndefined();
  });
});

describe('护甲值', () => {
  it('原版四件套按材质给点', () => {
    expect(armorPoints('iron_chestplate')).toBe(6);
    expect(armorPoints('diamond_helmet')).toBe(3);
    expect(armorPoints('netherite_leggings')).toBe(6);
  });

  it('海龟壳单算，未知材质给 0', () => {
    expect(armorPoints('turtle_helmet')).toBe(2);
    expect(armorPoints('mystery_chestplate')).toBe(0);
    expect(armorPoints(undefined)).toBe(0);
  });
});

describe('取消与寻路', () => {
  it('delay 到点就 resolve', async () => {
    await expect(delay(1)).resolves.toBeUndefined();
  });

  it('delay 被 abort 时抛 AbortError', async () => {
    await expect(delay(10_000, AbortSignal.abort())).rejects.toThrow(/cancelled/);
  });

  it('清寻路目标优先用 setGoal(null)', () => {
    const calls: unknown[] = [];
    const bot = { pathfinder: { setGoal: (goal: unknown) => calls.push(goal) } };
    clearPathfinderGoal(bot);
    expect(calls).toEqual([null]);
  });

  it('没有 setGoal 时退回 stop()', () => {
    let stopped = false;
    clearPathfinderGoal({ pathfinder: { stop: () => { stopped = true; } } });
    expect(stopped).toBe(true);
  });
});
