import { Vec3 } from 'vec3';
import type {
  MinecraftActionErrorCode,
  MinecraftActionResult,
  MinecraftLightingSnapshot,
} from './contracts.js';

export type MinecraftLightingPolicy = 'visibility' | 'spawn-risk';

export interface LightingPosition {
  x: number;
  y: number;
  z: number;
}

export interface LightingReading {
  loaded: boolean;
  blockLight: number | null;
  skyLight: number | null;
  canSeeSky?: boolean | null;
}

export interface LightingPolicyContext {
  policy: MinecraftLightingPolicy;
  dimension?: string;
  version?: string;
  timeOfDay?: number;
}

export interface TorchCandidate {
  target: LightingPosition;
  support: LightingPosition;
  kind: 'floor' | 'wall';
  /** Direction from the support block towards the torch cell. */
  face: 'top' | 'north' | 'south' | 'east' | 'west';
  expectedName: 'torch' | 'wall_torch';
  expectedFacing?: 'north' | 'south' | 'east' | 'west';
  blockLight: number;
  distance: number;
}

export interface TorchLightingSample extends LightingPosition {
  dimension: string;
  loaded: boolean;
  blockLight: number | null;
}

export interface TorchScanResult {
  /** Bounded, per-cell evidence from this scan; never borrow the body's current-cell sample. */
  samples: TorchLightingSample[];
  candidates: TorchCandidate[];
  darkPositions: LightingPosition[];
  unknownPositions: LightingPosition[];
  unsupportedPositions: LightingPosition[];
  protectedPositions: LightingPosition[];
  scannedPositions: number;
}

export interface EnsureLightingOptions extends LightingPolicyContext {
  radius: number;
  verticalRadius: number;
  maxTorches: number;
  protectedCells?: LightingPosition[];
  signal: AbortSignal;
  /** The adapter owns navigation and the actual Mineflayer place call. */
  place(item: any, candidate: TorchCandidate, signal: AbortSignal): Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  verificationPolls?: number;
  verificationIntervalMs?: number;
}

export class LightingActionError extends Error {
  constructor(
    readonly code: MinecraftActionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LightingActionError';
  }
}

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const VISIBILITY_LIGHT = 7;
const CARDINAL_FACES = ['north', 'south', 'east', 'west'] as const;
const FACE_VECTORS: Record<TorchCandidate['face'], LightingPosition> = {
  top: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
};

/** Sample only the body's column. A null block means unloaded, never darkness. */
export function sampleLighting(
  bot: any,
  position: LightingPosition | undefined = bot?.entity?.position,
  sampledAt = Date.now(),
): MinecraftLightingSnapshot {
  const unknown: MinecraftLightingSnapshot = {
    loaded: false,
    blockLight: null,
    skyLight: null,
    canSeeSky: null,
    sampledAt,
  };
  if (!position || typeof bot?.blockAt !== 'function') return unknown;
  const at = floored(position);
  const block = bot.blockAt(new Vec3(at.x, at.y, at.z));
  if (!block) return unknown;
  return {
    loaded: true,
    blockLight: lightLevel(block.light),
    skyLight: lightLevel(block.skyLight),
    canSeeSky: canSeeSky(bot, at),
    sampledAt,
  };
}

/**
 * Spawn risk uses block light only. Sky light must not hide spawn risk at night.
 * Visibility is a separate policy and may use sky light during daytime.
 */
export function needsLighting(sample: LightingReading, context: LightingPolicyContext): boolean | null {
  if (!sample.loaded || sample.blockLight === null) return null;
  if (context.policy === 'spawn-risk') {
    return sample.blockLight < minimumSpawnSafeBlockLight(context.dimension, context.version);
  }
  const daytime = context.timeOfDay !== undefined && daytimeAt(context.timeOfDay);
  if (daytime && sample.skyLight === null) return null;
  const effectiveLight = daytime
    ? Math.max(sample.blockLight, sample.skyLight ?? 0)
    : sample.blockLight;
  return effectiveLight < VISIBILITY_LIGHT;
}

/** Minimum block light which prevents the common hostile spawns for this ruleset. */
export function minimumSpawnSafeBlockLight(dimension?: string, version?: string): number {
  const normalized = String(dimension ?? 'overworld').toLowerCase().replace(/^minecraft:/, '');
  if (normalized.includes('nether')) return 12;
  if (normalized.includes('end')) return 8;
  return versionAtLeast(version, 1, 18) ? 1 : 8;
}

export function scanTorchCandidates(
  bot: any,
  options: LightingPolicyContext & {
    center: LightingPosition;
    radius: number;
    verticalRadius: number;
    protectedCells?: LightingPosition[];
  },
): TorchScanResult {
  const center = floored(options.center);
  const radius = boundedInteger(options.radius, 0, 12);
  const verticalRadius = boundedInteger(options.verticalRadius, 0, 6);
  const protectedCells = new Set((options.protectedCells ?? []).map((cell) => positionKey(floored(cell))));
  const result: TorchScanResult = {
    samples: [],
    candidates: [],
    darkPositions: [],
    unknownPositions: [],
    unsupportedPositions: [],
    protectedPositions: [],
    scannedPositions: 0,
  };
  const unknown = new Set<string>();

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -verticalRadius; dy <= verticalRadius; dy += 1) {
        const target = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
        result.scannedPositions += 1;
        const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
        const sample = readBlockLighting(block);
        result.samples.push({
          ...target, dimension: String(options.dimension ?? 'overworld').replace(/^minecraft:/, ''),
          loaded: sample.loaded, blockLight: sample.blockLight,
        });
        const needed = needsLighting(sample, options);
        if (needed === null) {
          addUnique(result.unknownPositions, unknown, target);
          continue;
        }
        if (!needed || !isAirForTorch(block)) continue;
        result.darkPositions.push(target);
        if (protectedCells.has(positionKey(target))) {
          result.protectedPositions.push(target);
          continue;
        }

        const support = findTorchSupport(bot, target, hasWallTorch(bot));
        if (support.candidate) {
          result.candidates.push({
            ...support.candidate,
            blockLight: sample.blockLight!,
            distance: distanceSquared(center, target),
          });
        } else if (support.unknownPosition) {
          addUnique(result.unknownPositions, unknown, support.unknownPosition);
        } else {
          result.unsupportedPositions.push(target);
        }
      }
    }
  }

  result.candidates.sort((left, right) => (
    left.distance - right.distance
    || left.blockLight - right.blockLight
    || (left.kind === right.kind ? 0 : left.kind === 'floor' ? -1 : 1)
    || left.target.y - right.target.y
    || left.target.z - right.target.z
    || left.target.x - right.target.x
    || left.face.localeCompare(right.face)
  ));
  return result;
}

export function isAirForTorch(block: any): boolean {
  return Boolean(block && AIR_BLOCKS.has(String(block.name)));
}

/** Full floor or cardinal wall support only; torches never hang from a ceiling. */
export function isTorchSupportBlock(block: any): boolean {
  return Boolean(block && block.boundingBox === 'block' && !AIR_BLOCKS.has(String(block.name)));
}

export function torchFaceVector(candidate: TorchCandidate): Vec3 {
  const vector = FACE_VECTORS[candidate.face];
  return new Vec3(vector.x, vector.y, vector.z);
}

/** Recheck after navigation so the generic place helper cannot clear a newly occupied cell. */
export function assertTorchPlacementStillValid(bot: any, candidate: TorchCandidate): void {
  const target = bot.blockAt(vec(candidate.target));
  if (!target) {
    throw new LightingActionError('unknown', 'torch target is not loaded', {
      reason: 'target_unloaded',
      position: candidate.target,
    });
  }
  if (!isAirForTorch(target)) {
    throw new LightingActionError('blocked', `torch target is occupied by ${target.name}`, {
      reason: 'target_occupied',
      position: candidate.target,
      actualName: target.name,
    });
  }
  const support = bot.blockAt(vec(candidate.support));
  if (!support) {
    throw new LightingActionError('unknown', 'torch support is not loaded', {
      reason: 'support_unloaded',
      position: candidate.support,
    });
  }
  if (!isTorchSupportBlock(support)) {
    throw new LightingActionError('blocked', `torch support is no longer solid: ${support.name}`, {
      reason: 'support_changed',
      position: candidate.support,
      actualName: support.name,
    });
  }
}

export function inspectTorchTarget(bot: any, candidate: TorchCandidate): {
  loaded: boolean;
  matches: boolean;
  block: any;
  actualFacing?: unknown;
} {
  const block = bot.blockAt(vec(candidate.target));
  if (!block) return { loaded: false, matches: false, block: null };
  const properties = block.getProperties?.() ?? {};
  const actualFacing = properties.facing;
  const positionMatches = !block.position || samePosition(block.position, candidate.target);
  // 朝向读不到时（不同版本的属性名不一样：facing / attachment）不要判死，位置和方块名对上就算
  const facingMatches = candidate.kind === 'floor' || actualFacing === undefined || actualFacing === candidate.expectedFacing;
  return {
    loaded: true,
    matches: block.name === candidate.expectedName && positionMatches && facingMatches,
    block,
    actualFacing,
  };
}

/** Bounded exact-target and real-light confirmation; no nearby-torch fallback. */
export async function waitForTorch(
  bot: any,
  candidate: TorchCandidate,
  context: LightingPolicyContext,
  options: {
    signal?: AbortSignal;
    polls?: number;
    intervalMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<
  | { ok: true; block: any }
  | { ok: false; code: MinecraftActionErrorCode; reason: string; details: Record<string, unknown> }
> {
  const polls = boundedInteger(options.polls ?? 8, 1, 20);
  const intervalMs = boundedInteger(options.intervalMs ?? 250, 0, 2_000);
  const sleep = options.sleep ?? delay;
  let last = inspectTorchTarget(bot, candidate);
  // 只要精确位置真的出现了火把就算插上了：block.light 在真实服务器上经常不跟客户端刷新
  // （以前要求方块光读数上升，结果 20 个火把插下去、每次都被判失败，白扔一个火把）
  for (let attempt = 0; attempt < polls; attempt += 1) {
    throwIfAborted(options.signal);
    last = inspectTorchTarget(bot, candidate);
    if (last.matches) return { ok: true, block: last.block };
    if (attempt + 1 < polls) await sleep(intervalMs, options.signal);
  }
  const details = {
    policy: context.policy,
    position: candidate.target,
    expectedName: candidate.expectedName,
    expectedFacing: candidate.expectedFacing,
    actualName: last.block?.name,
    actualFacing: last.actualFacing,
    actualBlockLight: lightLevel(last.block?.light),
    polls,
  };
  if (!last.loaded) return { ok: false, code: 'unknown', reason: 'target_unloaded', details };
  return { ok: false, code: 'blocked', reason: 'exact_target_mismatch', details };
}

/** Run a bounded local scan/place loop. Crafting and resupply intentionally stay upstream. */
export async function ensureLighting(
  bot: any,
  options: EnsureLightingOptions,
): Promise<MinecraftActionResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const center = floored(bot.entity?.position);
  const before = inventoryCounts(bot);
  const worldChanges: MinecraftActionResult['worldChanges'] = [];
  let placed = 0;
  /** 这一轮插不进去的格子：换下一个，别因为一个格子（被占、朝向对不上）整次照明都失败 */
  const failedTargets = new Set<string>();
  const cellKey = (p: LightingPosition) => `${p.x},${p.y},${p.z}`;
  let failed = 0;
  let lastFailure: { code: MinecraftActionErrorCode; reason: string; details: Record<string, unknown> } | null = null;

  const complete = (scan: TorchScanResult): MinecraftActionResult => ({
    actionId: '',
    outcome: 'succeeded',
    summary: placed > 0
      ? `placed ${placed} torch${placed === 1 ? '' : 'es'}; scanned lighting now satisfies ${options.policy}`
      : `scanned lighting already satisfies ${options.policy}`,
    durationMs: Math.max(0, now() - started),
    inventoryDelta: inventoryDifference(before, inventoryCounts(bot)),
    worldChanges,
    observations: [{
      id: `lighting.evidence:${started}`, at: now(), severity: 'info', kind: 'lighting-evidence',
      text: `bounded lighting scan of ${scan.samples.length} cells`,
      data: { policy: options.policy, samples: scan.samples },
    }],
  });

  const fail = (
    code: MinecraftActionErrorCode,
    reason: string,
    scan: TorchScanResult,
    extra: Record<string, unknown> = {},
  ): MinecraftActionResult => {
    const details: Record<string, unknown> = {
      reason,
      policy: options.policy,
      placed,
      remainingDark: scan.darkPositions.length,
      unknownPositions: scan.unknownPositions.slice(0, 16),
      unsupportedPositions: scan.unsupportedPositions.slice(0, 16),
      protectedPositions: scan.protectedPositions.slice(0, 16),
      ...extra,
    };
    const summary = `lighting ${reason.replaceAll('_', ' ')} after placing ${placed} torch${placed === 1 ? '' : 'es'}`;
    return {
      actionId: '',
      outcome: code === 'cancelled' && placed === 0 ? 'cancelled' : placed > 0 ? 'partial' : 'failed',
      summary,
      durationMs: Math.max(0, now() - started),
      inventoryDelta: inventoryDifference(before, inventoryCounts(bot)),
      worldChanges,
      observations: [{
        id: `lighting.${reason}:${started}`,
        at: now(),
        severity: 'warning',
        kind: `lighting.${reason}`,
        text: summary,
        data: details,
      }],
      error: { code, recoverable: code !== 'adapter_error', details },
    };
  };

  for (;;) {
    throwIfAborted(options.signal);
    const scan = scanTorchCandidates(bot, {
      ...options,
      center,
      protectedCells: options.protectedCells,
    });
    if (scan.darkPositions.length === 0 && scan.unknownPositions.length === 0) return complete(scan);
    if (placed >= options.maxTorches) return fail('blocked', 'placement_limit', scan);
    // 失败格子的上限：换几个位置试，别在一个插不上的格子上无限重试
    if (failed >= options.maxTorches * 2) return fail('blocked', 'placement_limit', scan);
    const candidate = scan.candidates.find((c) => !failedTargets.has(cellKey(c.target)));
    if (!candidate) {
      if (lastFailure) return fail(lastFailure.code, lastFailure.reason, scan, lastFailure.details);
      if (scan.unknownPositions.length > 0) return fail('unknown', 'unloaded_area', scan);
      if (scan.protectedPositions.length > 0) return fail('blocked', 'protected_cells', scan);
      if (scan.candidates.length > 0) return fail('blocked', 'placement_failed', scan);
      return fail('blocked', 'no_valid_support', scan);
    }
    const item = bot.inventory?.items?.().find((entry: any) => entry.name === 'torch');
    if (!item) {
      return fail('missing_item', 'torch_missing', scan, {
        item: 'torch',
        missing: { torch: 1 },
        target: candidate.target,
      });
    }

    let placementError: unknown;
    try {
      await options.place(item, candidate, options.signal);
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      placementError = error;
    }

    // Even a rejected place call may have reached the server, so always reconcile the exact cell.
    const verified = await waitForTorch(bot, candidate, options, {
      signal: options.signal,
      polls: options.verificationPolls,
      intervalMs: options.verificationIntervalMs,
      sleep: options.sleep,
    });
    if (verified.ok) {
      placed += 1;
      worldChanges.push({
        kind: 'block_placed',
        name: verified.block.name,
        position: { ...candidate.target },
        count: 1,
      });
      continue;
    }

    const actionError = placementError instanceof LightingActionError ? placementError : undefined;
    // 走不过去（路找不到、卡住、超时）不是这个格子的问题：换格子也只是再卡一遍，直接收手，
    // 别把二十秒全耗在原地打转（以前是格子问题才该换下一个）
    const navigational = actionError && (actionError.code === 'path_unreachable' || actionError.code === 'timeout'
      || actionError.details.navigationReason !== undefined);
    if (actionError && navigational) {
      return fail(actionError.code, 'place_failed', scan, { ...verified.details, ...actionError.details });
    }
    // 只是这个格子插不上（方块被占、支撑没了、服务器没接受）：记下来换下一个，别让整次照明失败
    failedTargets.add(cellKey(candidate.target));
    failed += 1;
    lastFailure = {
      code: actionError?.code ?? verified.code,
      reason: placementError ? 'place_failed' : verified.reason,
      details: {
        ...verified.details,
        ...(actionError?.details ?? {}),
        ...(placementError ? { originalError: errorMessage(placementError) } : {}),
      },
    };
    continue;
  }
}

function findTorchSupport(
  bot: any,
  target: LightingPosition,
  wallTorchAvailable: boolean,
): { candidate?: Omit<TorchCandidate, 'blockLight' | 'distance'>; unknownPosition?: LightingPosition } {
  let unknownPosition: LightingPosition | undefined;
  const faces: TorchCandidate['face'][] = ['top', ...CARDINAL_FACES];
  for (const face of faces) {
    const direction = FACE_VECTORS[face];
    const support = {
      x: target.x - direction.x,
      y: target.y - direction.y,
      z: target.z - direction.z,
    };
    const block = bot.blockAt(vec(support));
    if (!block) {
      unknownPosition ??= support;
      continue;
    }
    if (!isTorchSupportBlock(block)) continue;
    if (face === 'top') {
      return {
        candidate: {
          target: { ...target },
          support,
          kind: 'floor',
          face,
          expectedName: 'torch',
        },
      };
    }
    return {
      candidate: {
        target: { ...target },
        support,
        kind: 'wall',
        face,
        expectedName: wallTorchAvailable ? 'wall_torch' : 'torch',
        expectedFacing: face,
      },
    };
  }
  return { unknownPosition };
}

function readBlockLighting(block: any): LightingReading {
  if (!block) return { loaded: false, blockLight: null, skyLight: null, canSeeSky: null };
  return {
    loaded: true,
    blockLight: lightLevel(block.light),
    skyLight: lightLevel(block.skyLight),
  };
}

function canSeeSky(bot: any, at: LightingPosition): boolean | null {
  const maxY = Number.isFinite(bot.world?.maxY)
    ? Math.floor(Number(bot.world.maxY))
    : versionAtLeast(bot.version, 1, 18) ? 319 : 255;
  for (let y = at.y + 1; y <= maxY; y += 1) {
    const block = bot.blockAt(new Vec3(at.x, y, at.z));
    if (!block) return null;
    if (block.transparent === false || (block.transparent === undefined && block.boundingBox === 'block')) return false;
  }
  return true;
}

function hasWallTorch(bot: any): boolean {
  return Boolean(bot.registry?.blocksByName?.wall_torch);
}

function lightLevel(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(15, number)) : null;
}

function versionAtLeast(version: string | undefined, major: number, minor: number): boolean {
  const match = String(version ?? '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2]);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function daytimeAt(timeOfDay: number): boolean {
  const ticks = ((Math.trunc(timeOfDay) % 24_000) + 24_000) % 24_000;
  return ticks >= 0 && ticks < 12_000;
}

function boundedInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : min));
}

function floored(position: LightingPosition | undefined): LightingPosition {
  return {
    x: Math.floor(Number(position?.x ?? 0)),
    y: Math.floor(Number(position?.y ?? 0)),
    z: Math.floor(Number(position?.z ?? 0)),
  };
}

function vec(position: LightingPosition): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

function positionKey(position: LightingPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function samePosition(left: LightingPosition, right: LightingPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function addUnique(
  positions: LightingPosition[],
  keys: Set<string>,
  position: LightingPosition,
): void {
  const key = positionKey(position);
  if (keys.has(key)) return;
  keys.add(key);
  positions.push(position);
}

function distanceSquared(left: LightingPosition, right: LightingPosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function inventoryCounts(bot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    counts[item.name] = (counts[item.name] ?? 0) + Number(item.count ?? 1);
  }
  return counts;
}

function inventoryDifference(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const difference: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[name] ?? 0) - (before[name] ?? 0);
    if (delta !== 0) difference[name] = delta;
  }
  return difference;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Minecraft lighting cancelled');
  error.name = 'AbortError';
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    function finish(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const error = new Error('Minecraft lighting cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
