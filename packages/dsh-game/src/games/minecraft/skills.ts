import type { MinecraftActionName } from './body/contracts.js';

/**
 * Pure skill -> existing body-action planning for a session pump.
 *
 * The session executes at most one returned action at a time, obtains a fresh
 * snapshot, re-plans if necessary, and validates the plan's typed completion
 * predicate. These functions do not execute actions or infer completion.
 * Crafting and smelting are deliberately non-idempotent; world-reconciling
 * movement, collection, lighting, equipping and owned-block resume are safe to
 * reconcile, but an uncertain non-idempotent result is never replayed here.
 */

export type MinecraftSkillName =
  | 'ensure_torches'
  | 'ensure_lighting'
  | 'ensure_tool'
  | 'equip_best_loadout'
  | 'secure_build_site'
  | 'build_resume'
  | 'recover_after_death'
  | 'ensure_food'
  | 'prepare_for_night';

export type SkillBodyAction = Extract<
  MinecraftActionName,
  | 'craft_item'
  | 'collect_item'
  | 'ensure_lighting'
  | 'equip'
  | 'go_to'
  | 'pickup_drops'
  | 'build_structure'
  | 'attack_entity'
  | 'flee'
  | 'hide'
  | 'sleep'
  | 'smelt_item'
>;

export interface SkillAction {
  bodyAction: SkillBodyAction;
  args: Record<string, unknown>;
  label: string;
  idempotent: boolean;
}

export interface SkillPosition {
  x: number;
  y: number;
  z: number;
}

export interface SkillBuildBlock extends SkillPosition {
  name: string;
  props: Record<string, string>;
}

export interface SkillTemporaryBlock extends SkillPosition {
  name: string;
}

/** Structurally accepts the existing MinecraftEnvironmentSnapshot. */
export interface SkillSnapshot {
  body?: {
    inventory?: Record<string, number>;
    position?: SkillPosition;
    food?: number;
    health?: number;
  };
  world?: {
    dimension?: string;
    timeOfDay?: number;
  };
  nearby?: {
    entities?: {
      name: string;
      hostile: boolean;
      distance?: number;
    }[];
  };
}

export interface SkillContext {
  snapshot?: SkillSnapshot;
  /** Injected when comparing a death drop's expiresAt; never read from a clock here. */
  now?: number;
}

export type SkillErrorCode = 'unsupported_skill' | 'missing_args' | 'invalid_args' | 'missing_context';

export interface SkillPlanningError {
  code: SkillErrorCode;
  message: string;
  skill?: string;
  field?: string;
}

export type SkillPlanResult =
  | { ok: true; actions: SkillAction[] }
  | { ok: false; error: SkillPlanningError };

export type RecoveryDisposition = 'supply' | 'defence' | 'reroute' | 'needs_decision' | 'budget_exhausted';

export interface SkillFailureInput {
  code: string;
  details?: Record<string, unknown>;
  certainty?: 'certain' | 'uncertain';
  /** Defaults to false, so an uncertain result is not automatically recovered. */
  idempotent?: boolean;
  /** Persisted by the session. Only the first automatic recovery is allowed. */
  recoveryAttempts?: number;
}

export type SkillRecoveryResult =
  | {
    ok: true;
    disposition: RecoveryDisposition;
    action: SkillAction | null;
    recoveryAttempts: number;
    reason?: string;
  }
  | { ok: false; error: SkillPlanningError };

export const MAX_SKILL_ACTIONS = 6;
export const MAX_BUILD_CELLS = 2_048;

export const SKILL_PRECONDITIONS: Record<MinecraftSkillName, string> = {
  ensure_torches: 'A real inventory snapshot is required; targetCount is total carried torches, not a blind craft amount.',
  ensure_lighting: 'Uses carried torches only. Call ensure_torches separately; unloaded or unlit areas remain world-verified.',
  ensure_tool: 'A real inventory snapshot is required. Generic tools default to wooden unless tier is explicit.',
  equip_best_loadout: 'A real inventory snapshot is required. Only the best carried weapon, shield and armor are equipped.',
  secure_build_site: 'Build geometry supplies protected cells. Hostiles cause one defence action before lighting is attempted.',
  build_resume: 'Requires canonical world-space blocks and a blueprintId; resume reconciles the world and ownedTemporary ledger.',
  recover_after_death: 'Requires a real death position and a safe retrieval path. Drop expiry requires injected now.',
  ensure_food: 'A real inventory snapshot is required. Acquires or prepares food; it never substitutes an eat action.',
  prepare_for_night: 'Uses carried torches, then hides or sleeps. Hostiles require a defence action first.',
};

class SkillInputException extends Error {
  constructor(readonly planningError: SkillPlanningError) {
    super(planningError.message);
  }
}

function inputError(
  code: SkillErrorCode,
  message: string,
  skill?: string,
  field?: string,
): never {
  throw new SkillInputException({ code, message, ...(skill ? { skill } : {}), ...(field ? { field } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function argsRecord(value: unknown, skill: MinecraftSkillName, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) inputError('invalid_args', `${skill} args must be a plain object`, skill);
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) inputError('invalid_args', `${skill} does not accept argument ${key}`, skill, key);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, skill: string): string {
  const value = record[key];
  if (value === undefined) inputError('missing_args', `${skill} requires ${key}`, skill, key);
  if (typeof value !== 'string' || !value.trim()) inputError('invalid_args', `${key} must be a non-empty string`, skill, key);
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, skill: string): string | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== 'string' || !String(record[key]).trim()) {
    inputError('invalid_args', `${key} must be a non-empty string`, skill, key);
  }
  return String(record[key]).trim();
}

function boundedInteger(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  skill: string,
): number {
  if (record[key] === undefined) return fallback;
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    inputError('invalid_args', `${key} must be an integer between ${minimum} and ${maximum}`, skill, key);
  }
  return value;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/^minecraft:/, '');
}

function finitePosition(value: unknown, skill: string, field: string, integer: boolean): SkillPosition {
  if (!isRecord(value)) inputError('invalid_args', `${field} must be a position`, skill, field);
  const coordinates = ['x', 'y', 'z'].map((key) => value[key]);
  if (coordinates.some((part) => typeof part !== 'number' || !Number.isFinite(part)
    || (integer && !Number.isSafeInteger(part)))) {
    inputError('invalid_args', `${field} has invalid coordinates`, skill, field);
  }
  return { x: coordinates[0] as number, y: coordinates[1] as number, z: coordinates[2] as number };
}

function positionList(value: unknown, skill: string, field: string): SkillPosition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BUILD_CELLS) {
    inputError('invalid_args', `${field} must be a bounded position array`, skill, field);
  }
  return canonicalPositions(value.map((entry) => finitePosition(entry, skill, field, true)));
}

function comparePositions(left: SkillPosition, right: SkillPosition): number {
  return left.y - right.y || left.z - right.z || left.x - right.x;
}

function positionKey(position: SkillPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function canonicalPositions(positions: SkillPosition[]): SkillPosition[] {
  const unique = new Map<string, SkillPosition>();
  for (const position of positions) unique.set(positionKey(position), position);
  return [...unique.values()].sort(comparePositions);
}

function inventory(context: SkillContext, skill: string): Record<string, number> {
  const value = context.snapshot?.body?.inventory;
  if (!value || !isRecord(value)) inputError('missing_context', `${skill} requires a real inventory snapshot`, skill, 'snapshot.body.inventory');
  return value;
}

function count(inventoryValue: Record<string, number>, item: string): number {
  const value = inventoryValue[item];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function action(
  bodyAction: SkillBodyAction,
  args: Record<string, unknown>,
  label: string,
  idempotent: boolean,
): SkillAction {
  return { bodyAction, args, label, idempotent };
}

function lightingAction(record: Record<string, unknown>, skill: MinecraftSkillName, protectedCells: SkillPosition[]): SkillAction {
  const radius = boundedInteger(record, 'radius', 6, 1, 10, skill);
  const verticalRadius = boundedInteger(record, 'verticalRadius', 2, 0, 4, skill);
  const maxTorches = boundedInteger(record, 'maxTorches', 4, 1, 8, skill);
  const policy = record.policy ?? (skill === 'ensure_lighting' ? 'visibility' : 'spawn-risk');
  if (policy !== 'visibility' && policy !== 'spawn-risk') inputError('invalid_args', 'policy must be visibility or spawn-risk', skill, 'policy');
  return action('ensure_lighting', {
    radius,
    verticalRadius,
    maxTorches,
    policy,
    ...(protectedCells.length ? { protectedCells } : {}),
  }, `Ensure ${policy} lighting with carried torches`, true);
}

const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'] as const;
type ToolKind = (typeof TOOL_KINDS)[number];
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'] as const;
type ToolTier = (typeof TOOL_TIERS)[number];

function isToolKind(value: string): value is ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(value);
}

function isToolTier(value: string): value is ToolTier {
  return (TOOL_TIERS as readonly string[]).includes(value);
}

function ensureTool(record: Record<string, unknown>, context: SkillContext): SkillAction[] {
  const skill = 'ensure_tool';
  const stock = inventory(context, skill);
  const exactItem = optionalString(record, 'item', skill);
  const generic = optionalString(record, 'tool', skill);
  if (exactItem && generic) inputError('invalid_args', 'use either item or tool, not both', skill);
  const requested = exactItem ?? generic;
  if (!requested) inputError('missing_args', 'ensure_tool requires item or tool', skill, 'item');
  const tier = optionalString(record, 'tier', skill);
  if (tier && !isToolTier(tier)) inputError('invalid_args', `unsupported tool tier ${tier}`, skill, 'tier');
  if (exactItem && tier) inputError('invalid_args', 'tier is only valid with a generic tool', skill, 'tier');

  const normalized = normalizeName(requested);
  const exactMatch = normalized.match(/^(netherite|diamond|iron|stone|golden|wooden)_(pickaxe|axe|shovel|hoe|sword)$/);
  if (exactMatch && tier) inputError('invalid_args', 'tier is only valid with a generic tool', skill, 'tier');
  if (generic && !isToolKind(normalized) && !exactMatch) inputError('invalid_args', `unsupported tool ${normalized}`, skill, 'tool');
  if (exactItem || exactMatch) {
    const item = normalized;
    if (count(stock, item) > 0) return [];
    return [action('craft_item', { item, quantity: 1 }, `Craft missing ${item}`, false)];
  }

  const kind = normalized as ToolKind;
  const candidates = tier ? [`${tier}_${kind}`] : TOOL_TIERS.map((candidate) => `${candidate}_${kind}`);
  if (candidates.some((item) => count(stock, item) > 0)) return [];
  const item = `${tier ?? 'wooden'}_${kind}`;
  return [action('craft_item', { item, quantity: 1 }, `Craft missing ${item}`, false)];
}

const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe', 'trident',
] as const;

const ARMOR: Record<string, readonly string[]> = {
  helmet: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'chainmail_helmet', 'golden_helmet', 'leather_helmet', 'turtle_helmet'],
  chestplate: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate', 'elytra'],
  leggings: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'chainmail_leggings', 'golden_leggings', 'leather_leggings'],
  boots: ['netherite_boots', 'diamond_boots', 'iron_boots', 'chainmail_boots', 'golden_boots', 'leather_boots'],
};

function bestCarried(stock: Record<string, number>, candidates: readonly string[]): string | undefined {
  return candidates.find((item) => count(stock, item) > 0);
}

function equipBestLoadout(context: SkillContext): SkillAction[] {
  const stock = inventory(context, 'equip_best_loadout');
  const selected = [
    bestCarried(stock, WEAPONS),
    count(stock, 'shield') > 0 ? 'shield' : undefined,
    ...Object.values(ARMOR).map((candidates) => bestCarried(stock, candidates)),
  ].filter((item): item is string => Boolean(item));
  return selected.map((item) => action('equip', { item }, `Equip best carried ${item}`, true));
}

function nearbyHostile(context: SkillContext, requested?: string): { name: string; distance?: number } | undefined {
  const hostiles = (context.snapshot?.nearby?.entities ?? [])
    .filter((entity) => entity.hostile && typeof entity.name === 'string' && entity.name.trim());
  if (requested) {
    const normalized = normalizeName(requested);
    return hostiles.find((entity) => normalizeName(entity.name) === normalized) ?? { name: normalized };
  }
  return [...hostiles].sort((left, right) => {
    const distance = (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY);
    return distance || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  })[0];
}

function defenceAction(
  context: SkillContext,
  strategy: 'auto' | 'attack' | 'flee' | 'hide',
  requested?: string,
): SkillAction {
  const hostile = nearbyHostile(context, requested);
  const weapon = bestCarried(context.snapshot?.body?.inventory ?? {}, WEAPONS);
  const selected = strategy === 'auto' ? (hostile && weapon ? 'attack' : 'flee') : strategy;
  if (selected === 'attack') {
    if (!hostile) inputError('missing_context', 'attack defence requires a hostile entity', undefined, 'snapshot.nearby.entities');
    return action('attack_entity', {
      entity: hostile.name,
      quantity: 1,
      kill: true,
      radius: 24,
    }, `Defend against ${hostile.name}`, false);
  }
  return action(selected, {}, selected === 'hide' ? 'Hide until the area is safe' : 'Flee from immediate danger', true);
}

function defenceStrategy(record: Record<string, unknown>, skill: MinecraftSkillName): 'auto' | 'attack' | 'flee' | 'hide' {
  const strategy = record.defence ?? 'auto';
  if (strategy !== 'auto' && strategy !== 'attack' && strategy !== 'flee' && strategy !== 'hide') {
    inputError('invalid_args', 'defence must be auto, attack, flee or hide', skill, 'defence');
  }
  return strategy;
}

function canonicalProps(value: unknown, skill: string, field: string): Record<string, string> {
  if (!isRecord(value)) inputError('invalid_args', `${field}.props must be an object`, skill, field);
  const props: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || typeof value[key] !== 'string') {
      inputError('invalid_args', `${field}.props must contain safe string values`, skill, field);
    }
    props[key] = value[key] as string;
  }
  return props;
}

function canonicalBlocks(value: unknown, skill: MinecraftSkillName): SkillBuildBlock[] {
  if (!Array.isArray(value) || value.length > MAX_BUILD_CELLS) {
    inputError('invalid_args', 'blocks must be a bounded array', skill, 'blocks');
  }
  const byPosition = new Map<string, SkillBuildBlock>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) inputError('invalid_args', `blocks[${index}] must be an object`, skill, 'blocks');
    const position = finitePosition(entry, skill, `blocks[${index}]`, true);
    const name = normalizeName(requiredString(entry, 'name', skill));
    const props = canonicalProps(entry.props ?? {}, skill, `blocks[${index}]`);
    const block = { ...position, name, props };
    const key = positionKey(position);
    const previous = byPosition.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(block)) {
      inputError('invalid_args', `conflicting blocks at ${key}`, skill, 'blocks');
    }
    byPosition.set(key, block);
  }
  return [...byPosition.values()].sort((left, right) => comparePositions(left, right)
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function canonicalTemporary(value: unknown, skill: MinecraftSkillName): SkillTemporaryBlock[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BUILD_CELLS) {
    inputError('invalid_args', 'ownedTemporary must be a bounded array', skill, 'ownedTemporary');
  }
  const byPosition = new Map<string, SkillTemporaryBlock>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) inputError('invalid_args', `ownedTemporary[${index}] must be an object`, skill, 'ownedTemporary');
    const position = finitePosition(entry, skill, `ownedTemporary[${index}]`, true);
    const name = normalizeName(requiredString(entry, 'name', skill));
    const key = positionKey(position);
    const previous = byPosition.get(key);
    if (previous && previous.name !== name) inputError('invalid_args', `conflicting temporary block at ${key}`, skill, 'ownedTemporary');
    byPosition.set(key, { ...position, name });
  }
  return [...byPosition.values()].sort((left, right) => comparePositions(left, right)
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

interface CanonicalBuild {
  blocks: SkillBuildBlock[];
  clear: SkillPosition[];
  ownedTemporary: SkillTemporaryBlock[];
}

function canonicalBuild(record: Record<string, unknown>, skill: MinecraftSkillName, temporary: boolean): CanonicalBuild {
  const blocks = canonicalBlocks(record.blocks ?? [], skill);
  const clear = positionList(record.clear, skill, 'clear');
  const blockCells = new Set(blocks.map(positionKey));
  if (clear.some((position) => blockCells.has(positionKey(position)))) {
    inputError('invalid_args', 'blocks and clear cannot contain the same cell', skill, 'clear');
  }
  return { blocks, clear, ownedTemporary: temporary ? canonicalTemporary(record.ownedTemporary, skill) : [] };
}

const RAW_TO_COOKED: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
};
const COOKED_TO_RAW = Object.fromEntries(Object.entries(RAW_TO_COOKED).map(([raw, cooked]) => [cooked, raw]));
const FOOD_ANIMALS: Record<string, string> = {
  beef: 'cow', porkchop: 'pig', chicken: 'chicken', mutton: 'sheep', rabbit: 'rabbit', cod: 'cod', salmon: 'salmon',
};
const READY_FOOD = [
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'bread', 'baked_potato', 'apple', 'carrot', 'potato', 'beetroot', 'dried_kelp', 'golden_apple', 'enchanted_golden_apple',
] as const;
const CRAFTABLE_FOOD = new Set(['bread', 'cookie', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'suspicious_stew']);

function collectAction(item: string, quantity: number, radius: number, label?: string): SkillAction {
  return action('collect_item', {
    item,
    quantity,
    maxCount: quantity,
    radius,
  }, label ?? `Collect ${item} x${quantity}`, true);
}

function ensureFood(record: Record<string, unknown>, context: SkillContext): SkillAction[] {
  const skill = 'ensure_food';
  const stock = inventory(context, skill);
  const target = boundedInteger(record, 'count', 8, 1, 64, skill);
  const radius = boundedInteger(record, 'radius', 32, 1, 128, skill);
  const requested = optionalString(record, 'item', skill);
  if (requested) {
    const item = normalizeName(requested);
    const deficit = target - count(stock, item);
    if (deficit <= 0) return [];
    const raw = COOKED_TO_RAW[item];
    if (raw && count(stock, raw) > 0) {
      const quantity = Math.min(deficit, count(stock, raw));
      return [action('smelt_item', { item, quantity }, `Smelt ${item} x${quantity}`, false)];
    }
    const animal = FOOD_ANIMALS[raw ?? item];
    if (animal) {
      const quantity = Math.min(deficit, 8);
      return [action('attack_entity', { entity: animal, quantity, kill: true, radius }, `Hunt ${animal} for food`, false)];
    }
    if (item === 'bread') {
      if (count(stock, 'wheat') >= 3) {
        const quantity = Math.min(deficit, Math.floor(count(stock, 'wheat') / 3));
        return [action('craft_item', { item, quantity }, `Craft bread x${quantity}`, false)];
      }
      return [collectAction('wheat', Math.min(64, deficit * 3), radius, 'Collect wheat for bread')];
    }
    if (CRAFTABLE_FOOD.has(item)) return [action('craft_item', { item, quantity: deficit }, `Craft ${item} x${deficit}`, false)];
    return [collectAction(item, deficit, radius)];
  }

  const carried = READY_FOOD.reduce((total, item) => total + count(stock, item), 0);
  const deficit = target - carried;
  if (deficit <= 0) return [];
  for (const [raw, cooked] of Object.entries(RAW_TO_COOKED)) {
    if (count(stock, raw) > 0) {
      const quantity = Math.min(deficit, count(stock, raw));
      return [action('smelt_item', { item: cooked, quantity }, `Smelt ${cooked} x${quantity}`, false)];
    }
  }
  if (count(stock, 'wheat') >= 3) {
    const quantity = Math.min(deficit, Math.floor(count(stock, 'wheat') / 3));
    return [action('craft_item', { item: 'bread', quantity }, `Craft bread x${quantity}`, false)];
  }
  return [collectAction('apple', deficit, radius, 'Collect apples for a food supply')];
}

function isNight(timeOfDay: number | undefined): boolean {
  if (timeOfDay === undefined) return false;
  const time = ((timeOfDay % 24_000) + 24_000) % 24_000;
  return time >= 12_500 && time <= 23_500;
}

function planActions(skill: MinecraftSkillName, value: unknown, context: SkillContext): SkillAction[] {
  switch (skill) {
    case 'ensure_torches': {
      const record = argsRecord(value, skill, ['targetCount']);
      const stock = inventory(context, skill);
      const target = boundedInteger(record, 'targetCount', 8, 1, 64, skill);
      const deficit = target - count(stock, 'torch');
      if (deficit <= 0) return [];
      return [action('craft_item', { item: 'torch', quantity: deficit }, `Craft torch deficit x${deficit} (carried ${count(stock, 'torch')}/${target})`, false)];
    }
    case 'ensure_lighting': {
      const record = argsRecord(value, skill, ['radius', 'verticalRadius', 'maxTorches', 'policy', 'protectedCells']);
      return [lightingAction(record, skill, positionList(record.protectedCells, skill, 'protectedCells'))];
    }
    case 'ensure_tool':
      return ensureTool(argsRecord(value, skill, ['item', 'tool', 'tier']), context);
    case 'equip_best_loadout':
      argsRecord(value, skill, []);
      return equipBestLoadout(context);
    case 'secure_build_site': {
      const record = argsRecord(value, skill, [
        'blueprintId', 'label', 'blocks', 'clear', 'ownedTemporary', 'radius', 'verticalRadius', 'maxTorches', 'policy', 'defence',
      ]);
      const build = canonicalBuild(record, skill, false);
      if (nearbyHostile(context)) return [defenceAction(context, defenceStrategy(record, skill))];
      return [lightingAction(record, skill, canonicalPositions(
        [...build.blocks, ...build.clear].map(({ x, y, z }) => ({ x, y, z })),
      ))];
    }
    case 'build_resume': {
      const record = argsRecord(value, skill, ['blueprintId', 'label', 'origin', 'blocks', 'clear', 'ownedTemporary']);
      const blueprintId = requiredString(record, 'blueprintId', skill);
      if (record.blocks === undefined) inputError('missing_args', 'build_resume requires blocks', skill, 'blocks');
      const build = canonicalBuild(record, skill, true);
      if (!build.blocks.length) inputError('invalid_args', 'build_resume requires at least one block', skill, 'blocks');
      const buildLabel = optionalString(record, 'label', skill) ?? `resume ${blueprintId}`;
      const origin = record.origin === undefined ? undefined : finitePosition(record.origin, skill, 'origin', true);
      return [action('build_structure', {
        label: buildLabel,
        blueprintId,
        ...(origin ? { origin } : {}),
        blocks: build.blocks,
        clear: build.clear,
        ownedTemporary: build.ownedTemporary,
      }, `Resume blueprint ${blueprintId} from real world evidence`, true)];
    }
    case 'recover_after_death': {
      const record = argsRecord(value, skill, ['position', 'range', 'radius', 'expiresAt']);
      if (record.position === undefined) inputError('missing_args', 'recover_after_death requires position', skill, 'position');
      const position = finitePosition(record.position, skill, 'position', false);
      const range = boundedInteger(record, 'range', 2, 0, 8, skill);
      const radius = boundedInteger(record, 'radius', 12, 1, 32, skill);
      if (record.expiresAt !== undefined) {
        if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) {
          inputError('invalid_args', 'expiresAt must be finite', skill, 'expiresAt');
        }
        if (context.now === undefined) inputError('missing_context', 'expiresAt requires injected context.now', skill, 'now');
        if (context.now >= record.expiresAt) return [];
      }
      if (nearbyHostile(context)) return [defenceAction(context, 'auto')];
      return [
        action('go_to', { position, range }, 'Return to the death position', true),
        action('pickup_drops', { radius }, 'Pick up remaining death drops', true),
      ];
    }
    case 'ensure_food':
      return ensureFood(argsRecord(value, skill, ['item', 'count', 'radius']), context);
    case 'prepare_for_night': {
      const record = argsRecord(value, skill, [
        'strategy', 'radius', 'verticalRadius', 'maxTorches', 'protectedCells', 'defence',
      ]);
      if (nearbyHostile(context)) return [defenceAction(context, defenceStrategy(record, skill))];
      const strategy = record.strategy ?? 'auto';
      if (strategy !== 'auto' && strategy !== 'sleep' && strategy !== 'hide') {
        inputError('invalid_args', 'strategy must be auto, sleep or hide', skill, 'strategy');
      }
      const selected = strategy === 'auto' ? (isNight(context.snapshot?.world?.timeOfDay) ? 'sleep' : 'hide') : strategy;
      return [
        lightingAction(record, skill, positionList(record.protectedCells, skill, 'protectedCells')),
        action(selected, {}, selected === 'sleep' ? 'Sleep through the night' : 'Hide in a safe shelter', selected === 'hide'),
      ];
    }
  }
}

/** Plan a bounded ordered action list. Expected model/input failures are returned, not thrown. */
export function planSkill(skill: string, args: unknown = {}, context: SkillContext = {}): SkillPlanResult {
  if (!Object.hasOwn(SKILL_PRECONDITIONS, skill)) {
    return { ok: false, error: { code: 'unsupported_skill', message: `Unsupported Minecraft skill: ${skill}`, skill } };
  }
  try {
    const actions = planActions(skill as MinecraftSkillName, args, context);
    if (actions.length > MAX_SKILL_ACTIONS) {
      return { ok: false, error: { code: 'invalid_args', message: `${skill} exceeded the action budget`, skill } };
    }
    return { ok: true, actions };
  } catch (error) {
    if (error instanceof SkillInputException) return { ok: false, error: error.planningError };
    throw error;
  }
}

function missingSupply(details: Record<string, unknown>): { item: string; quantity: number } | undefined {
  const missing = details.missing;
  if (isRecord(missing)) {
    const entry = Object.entries(missing)
      .filter(([, amount]) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0];
    if (entry) return { item: normalizeName(entry[0]), quantity: Math.min(64, Math.max(1, Math.ceil(entry[1] as number))) };
  }
  if (typeof details.item === 'string' && details.item.trim()) {
    const amount = typeof details.quantity === 'number' && Number.isFinite(details.quantity) ? details.quantity : 1;
    return { item: normalizeName(details.item), quantity: Math.min(64, Math.max(1, Math.ceil(amount))) };
  }
  return undefined;
}

/**
 * Suggest at most one new recovery action. The caller persists recoveryAttempts
 * and passes it back on the next failure, which bounds automatic recovery to one.
 * This mapper never returns the failed action as an automatic replay.
 */
export function planFailureRecovery(input: SkillFailureInput, context: SkillContext = {}): SkillRecoveryResult {
  if (!isRecord(input) || typeof input.code !== 'string' || !input.code) {
    return { ok: false, error: { code: 'invalid_args', message: 'failure recovery requires an error code', field: 'code' } };
  }
  const attempts = input.recoveryAttempts ?? 0;
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    return { ok: false, error: { code: 'invalid_args', message: 'recoveryAttempts must be a non-negative integer', field: 'recoveryAttempts' } };
  }
  if (input.certainty === 'uncertain' && input.idempotent !== true) {
    return {
      ok: true,
      disposition: 'needs_decision',
      action: null,
      recoveryAttempts: attempts,
      reason: 'Uncertain non-idempotent outcome requires world/inventory reconciliation, not replay',
    };
  }
  if (attempts >= 1) {
    return { ok: true, disposition: 'budget_exhausted', action: null, recoveryAttempts: attempts, reason: 'Automatic recovery budget exhausted' };
  }
  const details = input.details ?? {};
  if (!isRecord(details)) return { ok: false, error: { code: 'invalid_args', message: 'failure details must be an object', field: 'details' } };

  let disposition: RecoveryDisposition = 'needs_decision';
  let recovered: SkillAction | null = null;
  if (input.code === 'missing_item') {
    const supply = missingSupply(details);
    if (supply) {
      recovered = collectAction(supply.item, supply.quantity, 64, `Supply missing ${supply.item} x${supply.quantity}`);
      disposition = 'supply';
    }
  } else if (input.code === 'missing_tool') {
    const tool = typeof details.item === 'string' ? details.item : details.tool;
    if (typeof tool === 'string' && tool.trim()) {
      const planned = planSkill('ensure_tool', { tool: tool.trim() }, context);
      if (planned.ok && planned.actions.length === 1) {
        recovered = planned.actions[0];
        disposition = 'supply';
      }
    }
  } else if (input.code === 'hostiles' || input.code === 'hostile'
    || (input.code === 'unsafe' && (details.requirement === 'clear-hostiles'
      || /hostile|enemy|mob/i.test(String(details.reason ?? details.message ?? ''))))) {
    const entity = typeof details.entity === 'string' ? details.entity : undefined;
    recovered = defenceAction(context, 'auto', entity);
    disposition = 'defence';
  } else if (input.code === 'low_food' || (input.code === 'unsafe' && (details.requirement === 'food'
    || /food|hunger/i.test(String(details.reason ?? details.message ?? ''))))) {
    const planned = planSkill('ensure_food', {}, context);
    if (planned.ok && planned.actions.length > 0) {
      recovered = planned.actions[0];
      disposition = 'supply';
    }
  } else if (input.code === 'path_unreachable' || input.code === 'blocked') {
    const alternate = details.reroutePosition ?? details.safePosition;
    if (alternate !== undefined) {
      let position: SkillPosition;
      try {
        position = finitePosition(alternate, 'path recovery', 'reroutePosition', false);
      } catch (error) {
        if (error instanceof SkillInputException) return { ok: false, error: error.planningError };
        throw error;
      }
      recovered = action('go_to', { position, range: 1 }, 'Reroute through an explicit safe position', true);
      disposition = 'reroute';
    }
  }

  if (!recovered) {
    return {
      ok: true,
      disposition: 'needs_decision',
      action: null,
      recoveryAttempts: attempts,
      reason: `No safe automatic recovery for ${input.code}`,
    };
  }
  return { ok: true, disposition, action: recovered, recoveryAttempts: attempts + 1 };
}
