/**
 * mineflayer 适配层的纯工具函数：几何、坐标格式化、版本兼容、护甲值。
 *
 * 这些函数不碰 bot 状态、不持有闭包，从 mineflayerAdapter.ts 里抽出来是为了让那个
 * 4000 行的适配器只剩编排逻辑。改动这里不需要理解 Minecraft 协议。
 */

import { latestSupportedVersion } from 'mineflayer';

// ── 坐标与几何 ────────────────────────────────────────

export function vector(position: any): { x: number; y: number; z: number } {
  return {
    x: Number(position?.x ?? 0),
    y: Number(position?.y ?? 0),
    z: Number(position?.z ?? 0),
  };
}

export function formatPosition(position: any): string {
  const value = vector(position);
  return `${value.x.toFixed(0)},${value.y.toFixed(0)},${value.z.toFixed(0)}`;
}

export function formatPrecisePosition(position: any): string {
  const value = vector(position);
  return `${value.x.toFixed(2)},${value.y.toFixed(2)},${value.z.toFixed(2)}`;
}

export function formatPositionDelta(from: any, to: any): string {
  const start = vector(from);
  const end = vector(to);
  return `${(end.x - start.x).toFixed(2)},${(end.y - start.y).toFixed(2)},${(end.z - start.z).toFixed(2)}`;
}

export function distanceToBot(bot: any, position: any): number {
  const own = bot.entity?.position;
  if (!own || !position) return Number.POSITIVE_INFINITY;
  if (typeof own.distanceTo === 'function') return own.distanceTo(position);
  const x = Number(own.x ?? 0) - Number(position.x ?? 0);
  const y = Number(own.y ?? 0) - Number(position.y ?? 0);
  const z = Number(own.z ?? 0) - Number(position.z ?? 0);
  return Math.sqrt(x * x + y * y + z * z);
}

export function distanceBetween(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return Math.sqrt(x * x + y * y + z * z);
}

export function relativeDirection(bot: any, position: any): string {
  const own = bot.entity?.position;
  if (!own || !position) return 'unknown';
  const dx = Number(position.x ?? 0) - Number(own.x ?? 0);
  const dz = Number(position.z ?? 0) - Number(own.z ?? 0);
  const eastWest = Math.abs(dx) < 1 ? '' : dx > 0 ? 'east' : 'west';
  const northSouth = Math.abs(dz) < 1 ? '' : dz > 0 ? 'south' : 'north';
  return [northSouth, eastWest].filter(Boolean).join('-') || 'nearby';
}

export function clearPathfinderGoal(bot: any): void {
  if (typeof bot?.pathfinder?.setGoal === 'function') {
    bot.pathfinder.setGoal(null);
    return;
  }
  bot?.pathfinder?.stop?.();
}

// ── 取消与延时 ────────────────────────────────────────

export function abortError(): Error {
  const error = new Error('Minecraft collection cancelled');
  error.name = 'AbortError';
  return error;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

// ── 版本兼容 ──────────────────────────────────────────

export function isVersionDataMissingError(error: unknown): boolean {
  return error instanceof Error && /No data available for version/.test(error.message);
}

export function extractMissingVersion(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /No data available for version (\S+)/.exec(error.message);
  return match?.[1];
}

export function fallbackSupportedVersion(target: string): string | undefined {
  const targetParts = numericVersionParts(target);
  const latestParts = numericVersionParts(latestSupportedVersion ?? '');
  if (!targetParts || !latestParts) return undefined;
  // 只有同主版本（如 1.21.9 → 1.21.8）的次版本升级才值得回退；
  // 跨大版本（如 26.x → 1.21.x）协议必然不兼容，不要猜测。
  if (compareVersionParts(targetParts, latestParts) <= 0) return undefined;
  if (targetParts[0] !== latestParts[0]) return undefined;
  return latestSupportedVersion;
}

export function numericVersionParts(version: string): number[] | undefined {
  if (!/^\d+(\.\d+)*$/.test(version)) return undefined;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isFinite(part)) ? parts : undefined;
}

export function compareVersionParts(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── 护甲 ──────────────────────────────────────────────

/** 原版盔甲值：头盔、胸甲、护腿、靴子各加几点 */
const ARMOR_POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  golden: [2, 5, 3, 1],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
};
const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];

export function armorPoints(name: string | undefined): number {
  if (!name) return 0;
  if (name === 'turtle_helmet') return 2;
  const [material, piece] = name.split('_');
  const index = ARMOR_PIECES.indexOf(piece);
  return index >= 0 ? (ARMOR_POINTS[material]?.[index] ?? 0) : 0;
}
