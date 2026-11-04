import { Vec3 } from 'vec3';
import type { BuildSite } from './build.js';
import type { MinecraftActionErrorCode, MinecraftActionResult, MinecraftObservedEntity } from './contracts.js';
import { assessExcavationFluidRisk, dropBelow } from './fluidSafety.js';
import { isReplaceableForPlacement } from './placeBlock.js';
import { needsLighting, sampleLighting } from './lighting.js';

export class BuildSiteSafetyError extends Error {
  constructor(
    readonly code: MinecraftActionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BuildSiteSafetyError';
  }
}

export interface BuildSiteSafetyHooks {
  /** Real observed entities; the adapter owns version-specific hostile classification. */
  hostiles(): MinecraftObservedEntity[];
  navigate(center: Vec3, range: number, signal: AbortSignal): Promise<{
    ok: boolean;
    reason?: string;
    message?: string;
    endPos?: { x: number; y: number; z: number };
    distanceToTarget?: number;
  }>;
  ensureLighting(protectedCells: { x: number; y: number; z: number }[], signal: AbortSignal): Promise<MinecraftActionResult>;
  equipWeapon?(): Promise<string | null>;
  log?(text: string): void;
}

export interface BuildSiteSecurityReport {
  center: { x: number; y: number; z: number };
  retreat: { x: number; y: number; z: number };
  lighting: MinecraftActionResult;
  checkedCells: number;
  skipped: string[];
}

/**
 * Generic survival-build gate. It deliberately performs no crafting, combat, RCON,
 * or creative stock operations: those decisions belong to the session scheduler.
 */
export async function secureBuildSite(
  bot: any,
  site: BuildSite,
  hooks: BuildSiteSafetyHooks,
): Promise<BuildSiteSecurityReport> {
  const signal = site.signal;
  throwIfAborted(signal);
  const center = siteCenter(site);
  const skipped: string[] = [];

  const weapon = await hooks.equipWeapon?.();
  if (!weapon) {
    throw new BuildSiteSafetyError('unsafe', 'no melee weapon is available for construction defence', {
      requirement: 'weapon', suggestedItems: ['wooden_sword', 'stone_sword', 'iron_sword'],
    });
  }
  assertVitals(bot);

  const before = threateningHostiles(hooks.hostiles(), bot.entity?.position, center);
  if (before.length) throw hostileError(before);

  const range = Math.max(2, Math.min(6, Math.ceil(Math.max(site.max.x - site.min.x, site.max.z - site.min.z) / 4)));
  const navigation = await hooks.navigate(new Vec3(center.x, center.y, center.z), range, signal);
  if (!navigation.ok) {
    const code: MinecraftActionErrorCode = navigation.reason === 'noPath'
      ? 'path_unreachable'
      : navigation.reason === 'timeout' ? 'timeout'
        : navigation.reason === 'interrupted' ? 'cancelled' : 'blocked';
    throw new BuildSiteSafetyError(code, `cannot enter build site: ${navigation.message ?? navigation.reason ?? 'navigation failed'}`, {
      requirement: 'entrance', center, navigationReason: navigation.reason,
      endPosition: navigation.endPos, distanceToTarget: navigation.distanceToTarget,
    });
  }
  throwIfAborted(signal);
  assertVitals(bot);

  const nearby = threateningHostiles(hooks.hostiles(), bot.entity?.position, center);
  if (nearby.length) throw hostileError(nearby);

  const checked = checkRequestedCells(bot, site);
  const retreat = safeRetreat(bot);
  if (!retreat) {
    throw new BuildSiteSafetyError('unsafe', 'no loaded, supported two-block-high retreat cell at the construction entrance', {
      requirement: 'retreat', position: bot.entity?.position,
    });
  }

  // Always scan a bounded area. The body action uses carried torches only and
  // avoids every blueprint and clear cell; supplies/crafting stay upstream.
  const protectedCells = [...site.protectedCells].map(parseCell);
  const lighting = await hooks.ensureLighting(protectedCells, signal);
  throwIfAborted(signal);
  if (lighting.outcome !== 'succeeded') {
    const sample = sampleLighting(bot, bot.entity?.position);
    const stillDark = needsLighting(sample, {
      policy: 'spawn-risk', dimension: bot.game?.dimension ?? bot.dimension,
      version: bot.version, timeOfDay: bot.time?.timeOfDay,
    });
    const missingTorch = lighting.error?.code === 'missing_item';
    if (stillDark !== false || missingTorch) {
      throw new BuildSiteSafetyError(lighting.error?.code ?? 'unsafe', `construction lighting is not secured: ${lighting.summary}`, {
        requirement: 'lighting', stillDark, protectedCells: protectedCells.length,
        lighting: lighting.error?.details ?? {}, missing: lighting.error?.details?.missing,
      });
    }
    skipped.push(`perimeter lighting: ${lighting.error?.code ?? lighting.outcome}`);
    hooks.log?.(`[build-site] accepted safe entrance despite perimeter lighting result: ${lighting.summary}`);
  }

  const after = threateningHostiles(hooks.hostiles(), bot.entity?.position, center);
  if (after.length) throw hostileError(after);
  return { center, retreat, lighting, checkedCells: checked, skipped };
}

function checkRequestedCells(bot: any, site: BuildSite): number {
  const cells = [...site.blocks, ...site.clear];
  const unknown = cells.filter((cell) => !bot.blockAt(new Vec3(cell.x, cell.y, cell.z)));
  if (unknown.length) {
    throw new BuildSiteSafetyError('unknown', `${unknown.length} requested build cells are not loaded`, {
      requirement: 'loaded', unknown: unknown.slice(0, 16), totalUnknown: unknown.length,
    });
  }
  for (const cell of site.clear) {
    const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!block || isReplaceableForPlacement(block) || block.name === 'bedrock') continue;
    const fluid = assessExcavationFluidRisk(bot, cell);
    if (fluid.unsafe) {
      throw new BuildSiteSafetyError('unsafe', `clearing ${block.name} would open ${fluid.liquid}`, {
        requirement: 'fluid-safety', position: cell, ...fluid,
      });
    }
    const drop = dropBelow(bot, cell);
    if (drop > 3) {
      throw new BuildSiteSafetyError('unsafe', `clearing ${block.name} would open a ${drop}-block drop`, {
        requirement: 'fall-safety', position: cell, drop,
      });
    }
  }
  return cells.length;
}

function assertVitals(bot: any): void {
  const health = Number(bot.health ?? 0);
  if (health < 12) {
    throw new BuildSiteSafetyError('unsafe', `health ${health} is below the construction minimum`, {
      requirement: 'health', health, minimum: 12,
    });
  }
  const food = Number(bot.food ?? 0);
  if (food < 6 && !hasFood(bot)) {
    throw new BuildSiteSafetyError('unsafe', `food ${food} is low and there is no carried food`, {
      requirement: 'food', food, minimum: 6, hasInventoryFood: false,
    });
  }
}

function hasFood(bot: any): boolean {
  const foodIds = new Set(Object.values(bot.registry?.foodsByName ?? {}).map((food: any) => food.id));
  return (bot.inventory?.items?.() ?? []).some((item: any) => foodIds.has(item.type));
}

function safeRetreat(bot: any): { x: number; y: number; z: number } | null {
  const position = bot.entity?.position;
  if (!position) return null;
  const at = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const feet = bot.blockAt(new Vec3(at.x, at.y, at.z));
  const head = bot.blockAt(new Vec3(at.x, at.y + 1, at.z));
  if (!feet || !head || !isReplaceableForPlacement(feet) || !isReplaceableForPlacement(head)) return null;
  for (let depth = 1; depth <= 2; depth += 1) {
    const ground = bot.blockAt(new Vec3(at.x, at.y - depth, at.z));
    if (!ground) return null;
    if (!isReplaceableForPlacement(ground)) return { ...at };
  }
  return null;
}

function threateningHostiles(
  hostiles: MinecraftObservedEntity[],
  body: { x: number; y: number; z: number } | undefined,
  center: { x: number; y: number; z: number },
): MinecraftObservedEntity[] {
  return hostiles.filter((entity) => (
    distance(entity.position, center) <= 16 || (body && distance(entity.position, body) <= 10)
  ));
}

function hostileError(hostiles: MinecraftObservedEntity[]): BuildSiteSafetyError {
  return new BuildSiteSafetyError('unsafe', `${hostiles.length} hostile mob(s) threaten the build site`, {
    requirement: 'clear-hostiles',
    hostiles: hostiles.slice(0, 8).map((entity) => ({ name: entity.name, position: entity.position, distance: entity.distance })),
  });
}

function siteCenter(site: BuildSite): { x: number; y: number; z: number } {
  return {
    x: Math.floor((site.min.x + site.max.x) / 2),
    y: Math.floor((site.min.y + site.max.y) / 2),
    z: Math.floor((site.min.z + site.max.z) / 2),
  };
}

function parseCell(value: string): { x: number; y: number; z: number } {
  const [x, y, z] = value.split(',').map(Number);
  return { x, y, z };
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new BuildSiteSafetyError('cancelled', 'construction security check was cancelled', { reason: 'cancelled' });
}
