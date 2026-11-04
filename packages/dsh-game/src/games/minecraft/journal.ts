/**
 * 世界日志：一个服务器上的一个她（地址 + 名字）一本，连着几天玩同一个世界时能接着上次。
 * 存在 DSH 主目录（dsh-game/minecraft-worlds/<地址>__<名字>.json），每次有变化马上写盘。
 *
 *   她写的：长期目标（goal）、图纸（design / template）、地点（mark：家、矿洞、村庄……哪里值得记由她定）
 *   身体自动记的（做完、结果明确的事）：盖过的建筑、种的地、睡过的床、死在哪、这局结束时在哪做什么
 *   背包变化、聊天、每个时刻的状态不记（那些是流水，不是日志）
 *
 * v2 另外保存一个结构化计划和一个施工 job。施工只保存完整图纸、阶段和临时块所有权，
 * 不保存逐块进度游标；恢复后必须重新读取世界求差量。
 *
 * 开了 RCON 时记下世界种子：下次开局种子对不上（服务器换了新世界），旧日志改名留着，开一本新的。
 * 上限：地点、建筑、地各 30 条（开局只给她看最近 10 条，journal 看全部），图纸 20 张（丢最久没用的），死亡留最近 5 次。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BuildBlock, BuildTemporaryBlock } from './body/build.js';
import {
  canonicalJson,
  migratePlan,
  parsePlan,
  planDefinition,
  type MinecraftPlan,
  type PlanIdAndTime,
} from './plan.js';

interface Spot {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

export interface MinecraftBuildBlockPosition {
  x: number;
  y: number;
  z: number;
}

export const MINECRAFT_BUILD_PHASES = [
  'SECURING',
  'BUILDING',
  'DEFENDING',
  'RECOVERING',
  'RESECURING',
  'BLOCKED',
  'DONE',
  'ABANDONED',
] as const;
export type MinecraftBuildPhase = (typeof MINECRAFT_BUILD_PHASES)[number];

/** JSON-only resumable work. There is deliberately no per-block completion cursor. */
export interface MinecraftBuildJob {
  id: string;
  planId?: string;
  stepId?: string;
  label: string;
  dimension: string;
  /** Canonically ordered; the builder still re-reads the world before doing any work. */
  blocks: BuildBlock[];
  clear: MinecraftBuildBlockPosition[];
  /** SHA-256 of canonical dimension + blocks + clear content. */
  contentHash: string;
  origin?: MinecraftBuildBlockPosition;
  phase: MinecraftBuildPhase;
  interruptionReason?: string;
  /** Only blocks whose placement was actually observed for this job belong here. */
  ownedTemporary: BuildTemporaryBlock[];
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface MinecraftBuildJobInput {
  id?: string;
  planId?: string;
  stepId?: string;
  label: string;
  dimension: string;
  blocks: readonly BuildBlock[];
  clear: readonly MinecraftBuildBlockPosition[];
  origin?: MinecraftBuildBlockPosition;
  phase?: MinecraftBuildPhase;
  interruptionReason?: string;
  ownedTemporary?: readonly BuildTemporaryBlock[];
  attempts?: number;
  maxAttempts?: number;
  /** Injectable for deterministic callers/tests; not persisted as an extra field. */
  now?: number;
}

export interface MinecraftBuildJobUpdate {
  phase?: MinecraftBuildPhase;
  /** null explicitly clears both the reason and the interrupted state. */
  interruptionReason?: string | null;
  ownedTemporary?: readonly BuildTemporaryBlock[];
  /** Absolute, monotonically nondecreasing attempt count (not a progress cursor). */
  attempts?: number;
  maxAttempts?: number;
  /** Injectable for deterministic callers/tests; not persisted as an extra field. */
  now?: number;
}

export type MinecraftPlanMode = 'shadow' | 'active';

export interface MinecraftPlanReceipt {
  id: string;
  definitionHash: string;
  status: MinecraftPlan['status'];
  updatedAt: number;
}

interface JournalData {
  version: 2;
  server: string;
  username: string;
  seed?: string;
  /** 在这个世界开过几局 */
  sessions: number;
  goal?: string;
  designs: { name: string; text: string; usedAt: number }[];
  buildings: (Spot & { name: string; done: number; total: number; at: number })[];
  fields: (Spot & { crop: string; size: number; at: number })[];
  places: (Spot & { name: string; at: number })[];
  bed?: Spot & { at: number };
  deaths: (Spot & { at: number })[];
  deathCount: number;
  /** 走过的传送门：两头的位置 */
  portals?: { a: Spot; b: Spot; at: number }[];
  last?: Spot & { at: number; doing?: string; inventory?: string };
  activePlan?: MinecraftPlan;
  planMode?: MinecraftPlanMode;
  /** Durable idempotent handoff receipts, including plans no longer active. */
  planReceipts?: MinecraftPlanReceipt[];
  activeJob?: MinecraftBuildJob;
}

const MAX_LIST = 30;
const SHOWN = 10;
const MAX_DESIGNS = 20;
const MAX_DEATHS = 5;
const MAX_BUILD_ARRAY = 100_000;
const MAX_BUILD_PROPS = 64;
const MAX_ATTEMPTS = 1_000;
const MAX_PLAN_STEPS = 1_000;
const MAX_PLAN_ARRAY = 10_000;
const MAX_PLAN_JSON_NODES = 200_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const DIMENSIONS: Record<string, string> = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
export const dimensionName = (d: string): string => DIMENSIONS[d.replace('minecraft:', '')] ?? d;
const at = (s: Spot) => `${s.dimension && dimensionName(s.dimension) !== '主世界' ? `${dimensionName(s.dimension)} ` : ''}(${s.x}, ${s.y}, ${s.z})`;

/** 现实时间：「10 月 24 日晚上」 */
export function when(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const part = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日${part}`;
}

export function journalFile(dir: string, server: string, username: string): string {
  return path.join(dir, `${server.replace(/[^A-Za-z0-9.-]+/g, '_')}__${username.replace(/[^A-Za-z0-9_]+/g, '_')}.json`);
}

/** 把旧文件改名留着（换了新世界、主人清空时） */
function setAside(file: string, why: string): void {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, file.replace(/\.json$/, `.${why}-${stamp}.json`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function integer(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  return integer(value, name, 0);
}

function boundedArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > maximum) throw new RangeError(`${name} exceeds the ${maximum} entry limit`);
  return value;
}

function blockPosition(value: unknown, name: string): MinecraftBuildBlockPosition {
  const r = record(value, name);
  return {
    x: integer(r.x, `${name}.x`, Number.MIN_SAFE_INTEGER),
    y: integer(r.y, `${name}.y`, Number.MIN_SAFE_INTEGER),
    z: integer(r.z, `${name}.z`, Number.MIN_SAFE_INTEGER),
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePosition(a: MinecraftBuildBlockPosition, b: MinecraftBuildBlockPosition): number {
  return a.x - b.x || a.y - b.y || a.z - b.z;
}

function canonicalBlocks(value: unknown): BuildBlock[] {
  const blocks = boundedArray(value, 'job.blocks', MAX_BUILD_ARRAY).map((entry, index) => {
    const name = `job.blocks[${index}]`;
    const r = record(entry, name);
    const source = record(r.props, `${name}.props`);
    const keys = Object.keys(source);
    if (keys.length > MAX_BUILD_PROPS) throw new RangeError(`${name}.props exceeds the ${MAX_BUILD_PROPS} entry limit`);
    const props: Record<string, string> = {};
    for (const key of keys.sort()) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`${name}.props contains forbidden key ${JSON.stringify(key)}`);
      props[key] = text(source[key], `${name}.props.${key}`, true);
    }
    return {
      ...blockPosition(r, name),
      name: text(r.name, `${name}.name`),
      props,
    };
  });
  const decorated = blocks.map((block) => ({ block, props: canonicalJson(block.props) }));
  decorated.sort((a, b) => comparePosition(a.block, b.block)
    || compareText(a.block.name, b.block.name)
    || compareText(a.props, b.props));
  return decorated.map(({ block }) => block);
}

function canonicalClear(value: unknown): MinecraftBuildBlockPosition[] {
  return boundedArray(value, 'job.clear', MAX_BUILD_ARRAY)
    .map((entry, index) => blockPosition(entry, `job.clear[${index}]`))
    .sort(comparePosition);
}

function canonicalTemporary(value: unknown): BuildTemporaryBlock[] {
  const temporary = boundedArray(value, 'job.ownedTemporary', MAX_BUILD_ARRAY).map((entry, index) => {
    const name = `job.ownedTemporary[${index}]`;
    const r = record(entry, name);
    return { ...blockPosition(r, name), name: text(r.name, `${name}.name`) };
  }).sort((a, b) => comparePosition(a, b) || compareText(a.name, b.name));
  const occupied = new Set<string>();
  for (const block of temporary) {
    const key = `${block.x},${block.y},${block.z}`;
    if (occupied.has(key)) throw new TypeError(`job.ownedTemporary contains duplicate position ${key}`);
    occupied.add(key);
  }
  return temporary;
}

function buildContentHash(dimension: string, blocks: BuildBlock[], clear: MinecraftBuildBlockPosition[]): string {
  return createHash('sha256').update(canonicalJson({ dimension, blocks, clear })).digest('hex');
}

/** Hash a fresh request exactly as it will be persisted, including canonical array order. */
export function buildRequestHash(
  dimension: string,
  blocks: readonly BuildBlock[],
  clear: readonly MinecraftBuildBlockPosition[],
): string {
  return buildContentHash(dimension, canonicalBlocks(blocks), canonicalClear(clear));
}

export function planDefinitionHash(plan: MinecraftPlan): string {
  return createHash('sha256').update(canonicalJson(planDefinition(plan))).digest('hex');
}

function optionalId(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}

/** Explicit field construction strips signals, callbacks and accidental progress metadata. */
function parseBuildJob(value: unknown): MinecraftBuildJob {
  const r = record(value, 'job');
  const dimension = text(r.dimension, 'job.dimension');
  const blocks = canonicalBlocks(r.blocks);
  const clear = canonicalClear(r.clear);
  const contentHash = buildContentHash(dimension, blocks, clear);
  if (r.contentHash !== contentHash) throw new TypeError('job.contentHash does not match its canonical content');
  const phase = text(r.phase, 'job.phase') as MinecraftBuildPhase;
  if (!(MINECRAFT_BUILD_PHASES as readonly string[]).includes(phase)) throw new TypeError('job.phase is invalid');
  const maxAttempts = integer(r.maxAttempts, 'job.maxAttempts', 1, MAX_ATTEMPTS);
  const createdAt = timestamp(r.createdAt, 'job.createdAt');
  const updatedAt = timestamp(r.updatedAt, 'job.updatedAt');
  if (updatedAt < createdAt) throw new RangeError('job.updatedAt must not precede createdAt');
  const planId = optionalId(r.planId, 'job.planId');
  const stepId = optionalId(r.stepId, 'job.stepId');
  const origin = r.origin === undefined ? undefined : blockPosition(r.origin, 'job.origin');
  const interruptionReason = r.interruptionReason === undefined
    ? undefined
    : text(r.interruptionReason, 'job.interruptionReason');
  return {
    id: text(r.id, 'job.id'),
    ...(planId === undefined ? {} : { planId }),
    ...(stepId === undefined ? {} : { stepId }),
    label: text(r.label, 'job.label'),
    dimension,
    blocks,
    clear,
    contentHash,
    ...(origin ? { origin } : {}),
    phase,
    ...(interruptionReason === undefined ? {} : { interruptionReason }),
    ownedTemporary: canonicalTemporary(r.ownedTemporary),
    attempts: integer(r.attempts, 'job.attempts', 0, maxAttempts),
    maxAttempts,
    createdAt,
    updatedAt,
  };
}

/**
 * Bound work before the plan parser recursively normalizes untrusted persisted JSON.
 * This rejects oversized plans rather than truncating dependencies or attempt state.
 */
function assertBoundedPlan(value: unknown): void {
  if (!isRecord(value)) return;
  if (Array.isArray(value.steps) && value.steps.length > MAX_PLAN_STEPS) {
    throw new RangeError(`plan.steps exceeds the ${MAX_PLAN_STEPS} entry limit`);
  }
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes++;
    if (nodes > MAX_PLAN_JSON_NODES) throw new RangeError('plan contains too many JSON values');
    if (current.depth > 64) throw new RangeError('plan is nested too deeply');
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_PLAN_ARRAY) throw new RangeError(`plan array exceeds the ${MAX_PLAN_ARRAY} entry limit`);
      for (const entry of current.value) pending.push({ value: entry, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const key of Object.keys(current.value)) {
        pending.push({ value: current.value[key], depth: current.depth + 1 });
      }
    }
  }
}

function restoredPlan(value: unknown): MinecraftPlan {
  assertBoundedPlan(value);
  return parsePlan(value);
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function legacySpot(value: unknown): Spot {
  const r = record(value, 'spot');
  return {
    x: finiteNumber(r.x, 'spot.x'),
    y: finiteNumber(r.y, 'spot.y'),
    z: finiteNumber(r.z, 'spot.z'),
    dimension: text(r.dimension, 'spot.dimension', true),
  };
}

function legacyList<T>(value: unknown, maximum: number, convert: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const entry of value.slice(0, maximum)) {
    try {
      result.push(convert(entry));
    } catch {
      // A damaged entry must not make the rest of an old journal unreadable.
    }
  }
  return result;
}

function legacyOptional<T>(value: unknown, convert: (entry: unknown) => T): T | undefined {
  if (value === undefined) return undefined;
  try {
    return convert(value);
  } catch {
    return undefined;
  }
}

function freshData(server: string, username: string, seed?: string | null): JournalData {
  return {
    version: 2,
    server,
    username,
    ...(seed ? { seed } : {}),
    sessions: 0,
    designs: [],
    buildings: [],
    fields: [],
    places: [],
    deaths: [],
    deathCount: 0,
  };
}

/** Migrate and defensively copy persisted data, retaining v1's display fields and ordering. */
function migrateJournal(raw: Record<string, unknown>, server: string, username: string, seed?: string | null): JournalData {
  const data = freshData(server, username, seed);
  if (typeof raw.seed === 'string' && !seed) data.seed = raw.seed;
  if (typeof raw.sessions === 'number' && Number.isSafeInteger(raw.sessions) && raw.sessions >= 0) data.sessions = raw.sessions;
  if (typeof raw.goal === 'string') data.goal = raw.goal;
  data.designs = legacyList(raw.designs, MAX_DESIGNS, (entry) => {
    const r = record(entry, 'design');
    return {
      name: text(r.name, 'design.name', true),
      text: text(r.text, 'design.text', true),
      usedAt: finiteNumber(r.usedAt, 'design.usedAt'),
    };
  });
  data.buildings = legacyList(raw.buildings, MAX_LIST, (entry) => {
    const r = record(entry, 'building');
    return {
      name: text(r.name, 'building.name', true),
      ...legacySpot(r),
      done: finiteNumber(r.done, 'building.done'),
      total: finiteNumber(r.total, 'building.total'),
      at: finiteNumber(r.at, 'building.at'),
    };
  });
  data.fields = legacyList(raw.fields, MAX_LIST, (entry) => {
    const r = record(entry, 'field');
    return {
      crop: text(r.crop, 'field.crop', true),
      ...legacySpot(r),
      size: finiteNumber(r.size, 'field.size'),
      at: finiteNumber(r.at, 'field.at'),
    };
  });
  data.places = legacyList(raw.places, MAX_LIST, (entry) => {
    const r = record(entry, 'place');
    return {
      name: text(r.name, 'place.name', true),
      ...legacySpot(r),
      at: finiteNumber(r.at, 'place.at'),
    };
  });
  data.deaths = legacyList(raw.deaths, MAX_DEATHS, (entry) => ({
    ...legacySpot(entry),
    at: finiteNumber(record(entry, 'death').at, 'death.at'),
  }));
  if (typeof raw.deathCount === 'number' && Number.isSafeInteger(raw.deathCount) && raw.deathCount >= 0) {
    data.deathCount = raw.deathCount;
  }
  data.bed = legacyOptional(raw.bed, (entry) => ({
    ...legacySpot(entry),
    at: finiteNumber(record(entry, 'bed').at, 'bed.at'),
  }));
  const portals = legacyList(raw.portals, MAX_LIST, (entry) => {
    const r = record(entry, 'portal');
    return {
      a: legacySpot(r.a),
      b: legacySpot(r.b),
      at: finiteNumber(r.at, 'portal.at'),
    };
  });
  if (Array.isArray(raw.portals)) data.portals = portals;
  data.last = legacyOptional(raw.last, (entry) => {
    const r = record(entry, 'last');
    return {
      ...legacySpot(r),
      at: finiteNumber(r.at, 'last.at'),
      ...(typeof r.doing === 'string' ? { doing: r.doing } : {}),
      ...(typeof r.inventory === 'string' ? { inventory: r.inventory } : {}),
    };
  });

  if (raw.activePlan !== undefined) {
    try {
      assertBoundedPlan(raw.activePlan);
      data.activePlan = migratePlan(raw.activePlan);
    } catch {
      // Keep the legacy journal usable even if its optional new plan is damaged.
    }
  } else if (raw.version === 1 && typeof data.goal === 'string' && data.goal.trim()) {
    try {
      data.activePlan = migratePlan(data.goal);
    } catch {
      // The original text goal remains available even if it cannot be structured.
    }
  }
  if (raw.planMode === 'shadow' || raw.planMode === 'active') data.planMode = raw.planMode;
  if (Array.isArray(raw.planReceipts)) {
    const receipts: MinecraftPlanReceipt[] = [];
    for (const entry of raw.planReceipts.slice(-32)) {
      try {
        const r = record(entry, 'planReceipt');
        const status = text(r.status, 'planReceipt.status');
        if (status !== 'active' && status !== 'done' && status !== 'blocked') continue;
        const definitionHash = text(r.definitionHash, 'planReceipt.definitionHash');
        if (!/^[a-f0-9]{64}$/.test(definitionHash)) continue;
        receipts.push({
          id: text(r.id, 'planReceipt.id'),
          definitionHash,
          status,
          updatedAt: finiteNumber(r.updatedAt, 'planReceipt.updatedAt'),
        });
      } catch {
        // A damaged old receipt must not make the world journal unusable.
      }
    }
    data.planReceipts = receipts;
  }
  if (raw.activeJob !== undefined) {
    try {
      data.activeJob = parseBuildJob(raw.activeJob);
    } catch {
      // Never resume from malformed content, a bad hash, or an oversized ledger.
    }
  }
  return data;
}

export class WorldJournal {
  private constructor(readonly file: string, private data: JournalData) {}

  /** 打开（没有就新开一本）。seed 对不上：旧的改名留着，开新的；note 说明发生了什么 */
  static open(dir: string, server: string, username: string, seed?: string | null): { journal: WorldJournal; note?: string } {
    const file = journalFile(dir, server, username);
    let raw: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isRecord(parsed)) raw = parsed;
    } catch {
      raw = null;
    }
    let note: string | undefined;
    if (raw && seed && typeof raw.seed === 'string' && raw.seed && raw.seed !== seed) {
      setAside(file, 'old-world');
      note = '这个服务器换了一个新世界（种子变了），上一个世界的日志收起来了，这本从头记。';
      raw = null;
    }
    const data = raw ? migrateJournal(raw, server, username, seed) : freshData(server, username, seed);
    const journal = new WorldJournal(file, data);
    return { journal, note };
  }

  /** 主人在设置里清空：改名留着 */
  static clear(dir: string, server: string, username: string): boolean {
    const file = journalFile(dir, server, username);
    if (!fs.existsSync(file)) return false;
    setAside(file, 'cleared');
    return true;
  }

  /** 设置面板看的：没有这本就是 null */
  static read(dir: string, server: string, username: string): string | null {
    const file = journalFile(dir, server, username);
    if (!fs.existsSync(file)) return null;
    return WorldJournal.open(dir, server, username).journal.full();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get goal(): string | undefined {
    return this.data.goal;
  }

  get designs(): { name: string; text: string }[] {
    return this.data.designs;
  }

  /** A defensive snapshot: mutating it cannot bypass validation or persistence. */
  get activePlan(): MinecraftPlan | undefined {
    return this.data.activePlan ? snapshot(this.data.activePlan) : undefined;
  }

  /** A defensive snapshot suitable for constructing a fresh world-diff build request. */
  get activeJob(): MinecraftBuildJob | undefined {
    return this.data.activeJob ? snapshot(this.data.activeJob) : undefined;
  }

  get planMode(): MinecraftPlanMode {
    return this.data.planMode ?? 'active';
  }

  planReceipt(id: string): MinecraftPlanReceipt | undefined {
    const receipt = this.data.planReceipts?.find((entry) => entry.id === id);
    return receipt ? { ...receipt } : undefined;
  }

  setPlanMode(mode: MinecraftPlanMode): void {
    if (mode !== 'shadow' && mode !== 'active') throw new TypeError('invalid plan mode');
    this.data.planMode = mode;
    this.save();
  }

  startSession(): void {
    this.data.sessions += 1;
    this.save();
  }

  setGoal(goal: string): void {
    this.data.goal = goal;
    this.save();
  }

  /** Accept a current plan, structured draft, text goal, or legacy journal goal. */
  setPlan(payload: unknown, options: PlanIdAndTime = {}): MinecraftPlan {
    assertBoundedPlan(payload);
    const plan = migratePlan(payload, options);
    assertBoundedPlan(plan);
    this.data.activePlan = plan;
    const receipt: MinecraftPlanReceipt = {
      id: plan.id,
      definitionHash: planDefinitionHash(plan),
      status: plan.status,
      updatedAt: plan.updatedAt,
    };
    const receipts = (this.data.planReceipts ?? []).filter((entry) => entry.id !== plan.id);
    receipts.push(receipt);
    this.data.planReceipts = receipts.slice(-32);
    this.save();
    return snapshot(plan);
  }

  /** Create the single resumable job. Existing jobs require explicit completion/abandon first. */
  createJob(input: MinecraftBuildJobInput): MinecraftBuildJob {
    if (this.data.activeJob) throw new Error(`build job ${this.data.activeJob.id} is still active`);
    record(input, 'job');
    const now = timestamp(input.now ?? Date.now(), 'job.now');
    const blocks = canonicalBlocks(input.blocks);
    const clear = canonicalClear(input.clear);
    const dimension = text(input.dimension, 'job.dimension');
    const planId = optionalId(input.planId, 'job.planId');
    const stepId = optionalId(input.stepId, 'job.stepId');
    const interruptionReason = input.interruptionReason === undefined
      ? undefined
      : text(input.interruptionReason, 'job.interruptionReason');
    const raw = {
      id: input.id ?? randomUUID(),
      ...(planId === undefined ? {} : { planId }),
      ...(stepId === undefined ? {} : { stepId }),
      label: input.label,
      dimension,
      blocks,
      clear,
      contentHash: buildContentHash(dimension, blocks, clear),
      ...(input.origin === undefined ? {} : { origin: blockPosition(input.origin, 'job.origin') }),
      phase: input.phase ?? 'SECURING',
      ...(interruptionReason === undefined ? {} : { interruptionReason }),
      ownedTemporary: input.ownedTemporary ?? [],
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: now,
      updatedAt: now,
    };
    const job = parseBuildJob(raw);
    this.data.activeJob = job;
    this.save();
    return snapshot(job);
  }

  /** Update recovery state and evidence only; canonical content and its hash are immutable. */
  updateJob(id: string, update: MinecraftBuildJobUpdate): MinecraftBuildJob {
    const current = this.data.activeJob;
    if (!current || current.id !== id) throw new Error(`unknown active build job ${id}`);
    const now = timestamp(update.now ?? Date.now(), 'job.now');
    if (now < current.updatedAt) throw new RangeError('job.now must not move updatedAt backwards');
    const attempts = update.attempts ?? current.attempts;
    if (!Number.isSafeInteger(attempts) || attempts < current.attempts) {
      throw new RangeError('job.attempts must be a nondecreasing safe integer');
    }
    const interruptionReason = update.interruptionReason === null
      ? undefined
      : update.interruptionReason === undefined
        ? current.interruptionReason
        : text(update.interruptionReason, 'job.interruptionReason');
    const raw: MinecraftBuildJob = {
      ...current,
      phase: update.phase ?? current.phase,
      ...(interruptionReason === undefined ? {} : { interruptionReason }),
      ownedTemporary: update.ownedTemporary === undefined
        ? current.ownedTemporary
        : canonicalTemporary(update.ownedTemporary),
      attempts,
      maxAttempts: update.maxAttempts ?? current.maxAttempts,
      updatedAt: now,
    };
    // Spread above can retain interruptionReason when null was requested; remove it explicitly.
    if (update.interruptionReason === null) delete raw.interruptionReason;
    const job = parseBuildJob(raw);
    this.data.activeJob = job;
    this.save();
    return snapshot(job);
  }

  /** Normal stops call updateJob instead. Only these two explicit outcomes remove recovery state. */
  clearJob(id: string, outcome: 'DONE' | 'ABANDONED'): boolean {
    if (outcome !== 'DONE' && outcome !== 'ABANDONED') throw new TypeError('clearJob requires DONE or ABANDONED');
    if (!this.data.activeJob || this.data.activeJob.id !== id) return false;
    delete this.data.activeJob;
    this.save();
    return true;
  }

  saveDesign(name: string, text: string): void {
    this.data.designs = [{ name, text, usedAt: Date.now() }, ...this.data.designs.filter((d) => d.name !== name)]
      .sort((a, b) => b.usedAt - a.usedAt).slice(0, MAX_DESIGNS);
    this.save();
  }

  usedDesign(name: string): void {
    const d = this.data.designs.find((x) => x.name === name);
    if (!d) return;
    d.usedAt = Date.now();
    this.save();
  }

  /** 盖过的这座建筑（最近的在前） */
  buildingsNamed(name: string): { x: number; y: number; z: number; dimension: string }[] {
    return this.data.buildings.filter((b) => b.name === name);
  }

  /** 盖完（或盖了一部分）：同一个名字盖在同一个地方算同一座 */
  addBuilding(name: string, spot: Spot, done: number, total: number): void {
    this.data.buildings = [{ name, ...spot, done, total, at: Date.now() }, ...this.data.buildings.filter((b) => !(b.name === name && b.x === spot.x && b.y === spot.y && b.z === spot.z))].slice(0, MAX_LIST);
    this.save();
  }

  addField(crop: string, spot: Spot, size: number): void {
    this.data.fields = [{ crop, ...spot, size, at: Date.now() }, ...this.data.fields.filter((f) => !(f.x === spot.x && f.y === spot.y && f.z === spot.z))].slice(0, MAX_LIST);
    this.save();
  }

  /** 记一个地点（同名覆盖）；spot 为 null 是删掉。返回给她看的一句话 */
  mark(name: string, spot: Spot | null): string {
    const had = this.data.places.some((p) => p.name === name);
    this.data.places = this.data.places.filter((p) => p.name !== name);
    if (!spot) {
      this.save();
      return had ? `「${name}」从日志里删掉了。` : `日志里本来就没有「${name}」。`;
    }
    this.data.places = [{ name, ...spot, at: Date.now() }, ...this.data.places].slice(0, MAX_LIST);
    this.save();
    return `记下了：「${name}」在 ${at(spot)}${had ? '（原来记的位置换成了这个）' : ''}。`;
  }

  setBed(spot: Spot): void {
    this.data.bed = { ...spot, at: Date.now() };
    this.save();
  }

  addDeath(spot: Spot): void {
    this.data.deaths = [{ ...spot, at: Date.now() }, ...this.data.deaths].slice(0, MAX_DEATHS);
    this.data.deathCount += 1;
    this.save();
  }

  /** 走了一次传送门：两头记下（同一对门只记一次） */
  addPortal(a: Spot, b: Spot): void {
    // 主世界那头写在前面（从哪边走过来都一样）
    if (b.dimension === 'overworld' && a.dimension !== 'overworld') [a, b] = [b, a];
    const near = (p: Spot, q: Spot) => p.dimension === q.dimension && Math.abs(p.x - q.x) <= 3 && Math.abs(p.y - q.y) <= 3 && Math.abs(p.z - q.z) <= 3;
    const same = (x: { a: Spot; b: Spot }) => (near(x.a, a) && near(x.b, b)) || (near(x.a, b) && near(x.b, a));
    this.data.portals = [{ a, b, at: Date.now() }, ...(this.data.portals ?? []).filter((x) => !same(x))].slice(0, MAX_LIST);
    this.save();
  }

  /** 这局玩到哪了（结束时，以及玩的过程中每隔一阵：DSH 被直接关掉也有个大概） */
  setLast(spot: Spot, doing?: string, inventory?: string): void {
    this.data.last = { ...spot, at: Date.now(), ...(doing ? { doing } : {}), ...(inventory ? { inventory } : {}) };
    this.save();
  }

  /** 开局时给她的事实（这一局算进 sessions 之前调用） */
  intro(): string {
    const d = this.data;
    if (!d.sessions) return `【这个世界】你第一次来这个世界（${d.server}）。你写下的目标、存好的图纸、mark 记的地点，还有盖过的房子、种过的地、床和死过的地方，都会记在这个世界的日志里，下次来还在。`;
    const lines = [`【这个世界】你在这里玩过 ${d.sessions} 次${d.last ? `，上次是 ${when(d.last.at)}，结束时在 ${dimensionName(d.last.dimension)} (${d.last.x}, ${d.last.y}, ${d.last.z})${d.last.doing ? `，正在${d.last.doing}` : ''}` : ''}。`];
    lines.push(...this.body(SHOWN));
    lines.push('这些记在这个世界的日志里（journal 看全部）。');
    return lines.join('\n');
  }

  /** 整本（journal 动作、设置面板） */
  full(): string {
    const d = this.data;
    const lines = [`这个世界（${d.server}，你叫 ${d.username}）的日志：玩过 ${d.sessions} 次。`];
    if (d.last) lines.push(`最后记下：${when(d.last.at)}在 ${dimensionName(d.last.dimension)} (${d.last.x}, ${d.last.y}, ${d.last.z})${d.last.doing ? `，正在${d.last.doing}` : ''}${d.last.inventory ? `；身上：${d.last.inventory}` : ''}`);
    const body = this.body(MAX_LIST);
    lines.push(...(body.length ? body : ['还什么都没记。']));
    return lines.join('\n');
  }

  private body(limit: number): string[] {
    const d = this.data;
    const more = (n: number) => (n > limit ? `……还有 ${n - limit} 个` : '');
    const out: string[] = [];
    if (d.goal) out.push(`目标：${d.goal}`);
    if (d.places.length) out.push(`地点：${d.places.slice(0, limit).map((p) => `${p.name} ${at(p)}`).join('、')}${more(d.places.length)}`);
    if (d.bed) out.push(`床（复活点）：${at(d.bed)}`);
    if (d.portals?.length) out.push(`传送门：${d.portals.slice(0, limit).map((x) => `${dimensionName(x.a.dimension)} (${x.a.x}, ${x.a.y}, ${x.a.z}) ↔ ${dimensionName(x.b.dimension)} (${x.b.x}, ${x.b.y}, ${x.b.z})`).join('；')}`);
    if (d.buildings.length) {
      out.push(`盖过：${d.buildings.slice(0, limit).map((b) => `「${b.name}」在 ${at(b)}${b.done >= b.total ? '，盖完了' : `，盖了 ${b.done}/${b.total} 块`}`).join('；')}${more(d.buildings.length)}`);
    }
    if (d.fields.length) out.push(`种过：${d.fields.slice(0, limit).map((f) => `${f.crop} ${f.size}×${f.size} 在 ${at(f)}`).join('；')}${more(d.fields.length)}`);
    if (d.designs.length) out.push(`存着的图纸：${d.designs.map((x) => x.name).join('、')}（可以直接 build）`);
    if (d.deaths.length) out.push(`死过 ${Math.max(d.deathCount, d.deaths.length)} 次，最近一次在 ${at(d.deaths[0])}，${when(d.deaths[0].at)}`);
    return out;
  }
}
