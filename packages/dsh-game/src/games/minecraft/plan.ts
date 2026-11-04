import { randomUUID } from 'node:crypto';

/**
 * Serializable, deterministic long-task plans. This module deliberately knows
 * nothing about sessions, workers, Mineflayer, clocks, or persistence. Callers
 * inject timestamps and real-world observations; model prose is never evidence
 * that a step completed.
 */

export const PLAN_VERSION = 1 as const;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_NO_PROGRESS_ATTEMPTS = 2;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_MAX_MS = 30_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PlanStatus = 'active' | 'done' | 'blocked';
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'blocked';
export type TriState = 'met' | 'unmet' | 'unknown';
export type ResultCertainty = 'certain' | 'uncertain';

export const FAILURE_DISPOSITIONS = ['retry', 'supply', 'defence', 'reroute', 'replan', 'needs_decision'] as const;
export type FailureDisposition = (typeof FAILURE_DISPOSITIONS)[number];

export interface WorldPosition {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

export type CompletionPredicate =
  | { type: 'inventory_at_least'; item: string; count: number }
  | { type: 'block_light_at_least'; position: WorldPosition; minimum: number }
  | { type: 'near_position'; position: WorldPosition; radius: number }
  | { type: 'blueprint_complete'; blueprintId: string }
  | { type: 'all_of'; predicates: CompletionPredicate[] };

export interface BlockLightObservation extends WorldPosition {
  /** An unloaded column is unknown even if an adapter reports a numeric light. */
  loaded: boolean;
  blockLight?: number;
}

export interface BlueprintObservation {
  /** Definitely missing or incorrect blocks from a real world diff. */
  remaining: number;
  /** Cells that could not be inspected because their chunks are unloaded. */
  unloaded: number;
}

/** Observations must come from the world/body adapter, not from model text. */
export interface CompletionObservation {
  inventory?: Record<string, number>;
  position?: WorldPosition;
  blockLight?: BlockLightObservation[];
  blueprints?: Record<string, BlueprintObservation>;
}

export interface PlanStepFailure {
  at: number;
  code: string;
  message?: string;
  disposition: FailureDisposition;
  fingerprint: string;
  certainty: ResultCertainty;
  idempotent: boolean;
  progressSignature?: string;
}

export interface PendingPlanRecovery {
  disposition: 'supply' | 'defence' | 'reroute';
  bodyAction: string;
  args: JsonObject;
  label: string;
  idempotent: boolean;
  /** Persisted before dispatch; an uncertain non-idempotent started action is never replayed. */
  started: boolean;
}

export interface PlanStep {
  id: string;
  skill: string;
  /** Recursively key-sorted JSON. Array order remains significant. */
  args: JsonObject;
  completion: CompletionPredicate;
  /** References must point to earlier steps. Step array order is authoritative. */
  dependsOn: string[];
  status: PlanStepStatus;
  attempts: number;
  maxAttempts: number;
  /** Consecutive failures of the same attempt without a changed world signature. */
  noProgressAttempts: number;
  maxNoProgressAttempts: number;
  lastFailure?: PlanStepFailure;
  /** Canonical JSON of the last observed real progress, or an opaque restored signature. */
  progressSignature?: string;
  /** Persisted automatic supply/reroute/defence budget for this step. */
  recoveryAttempts?: number;
  pendingRecovery?: PendingPlanRecovery;
  nextRetryAt?: number;
}

export interface MinecraftPlan {
  version: typeof PLAN_VERSION;
  id: string;
  revision: number;
  goal: string;
  status: PlanStatus;
  createdAt: number;
  updatedAt: number;
  steps: PlanStep[];
}

export interface PlanStepDraft {
  id?: string;
  skill: string;
  args?: JsonObject;
  completion: CompletionPredicate;
  dependsOn?: string[];
  maxAttempts?: number;
  maxNoProgressAttempts?: number;
}

export interface PlanIdAndTime {
  id?: string;
  now?: number;
}

export interface BeginStepOptions {
  now: number;
  /** Real progress at attempt start, used as the next no-progress baseline. */
  progress?: JsonValue;
  /** Proof that a supply/reroute recovery action finished; never inferred from model text. */
  recovered?: boolean;
}

export interface RetryBackoff {
  baseMs?: number;
  maxMs?: number;
}

export interface FailStepReport {
  now: number;
  code: string;
  message?: string;
  disposition: FailureDisposition;
  /** Defaults to the step skill. */
  action?: string;
  /** Defaults to the step's canonical args. */
  target?: JsonValue;
  context?: JsonValue;
  /** Safe default is false: an uncertain result then requires reconciliation. */
  idempotent?: boolean;
  certainty?: ResultCertainty;
  /** Real post-attempt state. Omitting it cannot demonstrate progress. */
  progress?: JsonValue;
  /** New persisted automatic-recovery count; must not move backwards. */
  recoveryAttempts?: number;
  /** One bounded recovery action, persisted before it is dispatched. */
  recovery?: Omit<PendingPlanRecovery, 'started'>;
  backoff?: RetryBackoff;
}

export interface AttemptFingerprintInput {
  planId?: string;
  stepId: string;
  action: string;
  target?: JsonValue;
  context?: JsonValue;
}

export type PlanValidationResult =
  | { ok: true; plan: MinecraftPlan }
  | { ok: false; errors: string[] };

export class PlanValidationError extends Error {
  override readonly name = 'PlanValidationError';

  constructor(readonly errors: string[]) {
    super(`Invalid Minecraft plan: ${errors.join('; ')}`);
  }
}

export class PlanTransitionError extends Error {
  override readonly name = 'PlanTransitionError';
}

function invalid(path: string, message: string): never {
  throw new PlanValidationError([`${path} ${message}`]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkRecord(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, 'must be a plain object');
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) invalid(path, `has unknown field ${JSON.stringify(key)}`);
  return value;
}

/** JSON-only normalization also rejects cycles, non-finite numbers and prototype keys. */
function normalizeJson(value: unknown, path = '$', seen = new Set<object>(), depth = 0): JsonValue {
  if (depth > 64) invalid(path, 'is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'must be a finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') invalid(path, 'must be JSON-serializable');
  if (seen.has(value)) invalid(path, 'must not contain a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) invalid(`${path}[${index}]`, 'must not be a sparse array entry');
        out.push(normalizeJson(value[index], `${path}[${index}]`, seen, depth + 1));
      }
      return out;
    }
    if (!isRecord(value)) invalid(path, 'must be a plain JSON object');
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        invalid(path, `contains forbidden key ${JSON.stringify(key)}`);
      }
      out[key] = normalizeJson(value[key], `${path}.${key}`, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function canonicalizeArgs(value: unknown): JsonObject {
  const normalized = normalizeJson(value);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    invalid('$.args', 'must be an object');
  }
  return normalized;
}

/** A readable canonical fingerprint; no hash truncation or random jitter. */
export function canonicalFingerprint(input: AttemptFingerprintInput): string {
  if (!isRecord(input)) invalid('$.fingerprint', 'must be an object');
  if (typeof input.stepId !== 'string' || !input.stepId) invalid('$.fingerprint.stepId', 'must be a non-empty string');
  if (typeof input.action !== 'string' || !input.action) invalid('$.fingerprint.action', 'must be a non-empty string');
  if (input.planId !== undefined && (typeof input.planId !== 'string' || !input.planId)) {
    invalid('$.fingerprint.planId', 'must be a non-empty string when present');
  }
  return canonicalJson({
    version: PLAN_VERSION,
    planId: input.planId ?? null,
    stepId: input.stepId,
    action: input.action,
    target: input.target ?? null,
    context: input.context ?? null,
  });
}

function stringField(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) invalid(`${path}.${key}`, 'must be a non-empty string');
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string, path: string): string | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== 'string') invalid(`${path}.${key}`, 'must be a string');
  return record[key];
}

function integerField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${path}.${key}`, `must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string, path: string, minimum?: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    invalid(`${path}.${key}`, `must be a finite number${minimum === undefined ? '' : ` >= ${minimum}`}`);
  }
  return value;
}

function positionField(value: unknown, path: string, block = false): WorldPosition {
  const record = checkRecord(value, path, ['x', 'y', 'z', 'dimension']);
  const coordinates = block
    ? ['x', 'y', 'z'].map((key) => integerField(record, key, path, Number.MIN_SAFE_INTEGER))
    : ['x', 'y', 'z'].map((key) => numberField(record, key, path));
  return {
    x: coordinates[0],
    y: coordinates[1],
    z: coordinates[2],
    dimension: stringField(record, 'dimension', path),
  };
}

function completionField(value: unknown, path: string): CompletionPredicate {
  if (!isRecord(value) || typeof value.type !== 'string') invalid(path, 'must have a completion predicate type');
  switch (value.type) {
    case 'inventory_at_least': {
      const record = checkRecord(value, path, ['type', 'item', 'count']);
      return {
        type: 'inventory_at_least',
        item: stringField(record, 'item', path),
        count: integerField(record, 'count', path, 1),
      };
    }
    case 'block_light_at_least': {
      const record = checkRecord(value, path, ['type', 'position', 'minimum']);
      return {
        type: 'block_light_at_least',
        position: positionField(record.position, `${path}.position`, true),
        minimum: integerField(record, 'minimum', path, 0, 15),
      };
    }
    case 'near_position': {
      const record = checkRecord(value, path, ['type', 'position', 'radius']);
      return {
        type: 'near_position',
        position: positionField(record.position, `${path}.position`),
        radius: numberField(record, 'radius', path, 0),
      };
    }
    case 'blueprint_complete': {
      const record = checkRecord(value, path, ['type', 'blueprintId']);
      return { type: 'blueprint_complete', blueprintId: stringField(record, 'blueprintId', path) };
    }
    case 'all_of': {
      const record = checkRecord(value, path, ['type', 'predicates']);
      if (!Array.isArray(record.predicates) || record.predicates.length === 0) {
        invalid(`${path}.predicates`, 'must be a non-empty array');
      }
      return {
        type: 'all_of',
        predicates: record.predicates.map((predicate, index) => completionField(predicate, `${path}.predicates[${index}]`)),
      };
    }
    default:
      return invalid(path, `has unsupported completion predicate ${JSON.stringify(value.type)}`);
  }
}

function dispositionField(value: unknown, path: string): FailureDisposition {
  if (typeof value !== 'string' || !(FAILURE_DISPOSITIONS as readonly string[]).includes(value)) {
    invalid(path, `must be one of ${FAILURE_DISPOSITIONS.join(', ')}`);
  }
  return value as FailureDisposition;
}

function failureField(value: unknown, path: string): PlanStepFailure {
  const record = checkRecord(value, path, [
    'at', 'code', 'message', 'disposition', 'fingerprint', 'certainty', 'idempotent', 'progressSignature',
  ]);
  const certainty = record.certainty;
  if (certainty !== 'certain' && certainty !== 'uncertain') invalid(`${path}.certainty`, 'must be certain or uncertain');
  if (typeof record.idempotent !== 'boolean') invalid(`${path}.idempotent`, 'must be boolean');
  const disposition = dispositionField(record.disposition, `${path}.disposition`);
  if (certainty === 'uncertain' && !record.idempotent && disposition !== 'needs_decision') {
    invalid(path, 'an uncertain non-idempotent result must require a decision');
  }
  const message = optionalStringField(record, 'message', path);
  const progressSignature = optionalStringField(record, 'progressSignature', path);
  return {
    at: integerField(record, 'at', path, 0),
    code: stringField(record, 'code', path),
    ...(message === undefined ? {} : { message }),
    disposition,
    fingerprint: stringField(record, 'fingerprint', path),
    certainty,
    idempotent: record.idempotent,
    ...(progressSignature === undefined ? {} : { progressSignature }),
  };
}

function pendingRecoveryField(value: unknown, path: string): PendingPlanRecovery {
  const record = checkRecord(value, path, ['disposition', 'bodyAction', 'args', 'label', 'idempotent', 'started']);
  const disposition = record.disposition;
  if (disposition !== 'supply' && disposition !== 'defence' && disposition !== 'reroute') {
    invalid(`${path}.disposition`, 'must be supply, defence or reroute');
  }
  if (typeof record.idempotent !== 'boolean' || typeof record.started !== 'boolean') {
    invalid(path, 'recovery idempotent and started must be boolean');
  }
  return {
    disposition,
    bodyAction: stringField(record, 'bodyAction', path),
    args: canonicalizeArgs(record.args),
    label: stringField(record, 'label', path),
    idempotent: record.idempotent,
    started: record.started,
  };
}

function stepField(value: unknown, path: string): PlanStep {
  const record = checkRecord(value, path, [
    'id', 'skill', 'args', 'completion', 'dependsOn', 'status', 'attempts', 'maxAttempts',
    'noProgressAttempts', 'maxNoProgressAttempts', 'lastFailure', 'progressSignature', 'recoveryAttempts', 'pendingRecovery', 'nextRetryAt',
  ]);
  const status = record.status;
  if (!['pending', 'running', 'done', 'blocked'].includes(String(status))) invalid(`${path}.status`, 'is invalid');
  if (!Array.isArray(record.dependsOn)) invalid(`${path}.dependsOn`, 'must be an array');
  const dependsOn = record.dependsOn.map((dependency, index) => {
    if (typeof dependency !== 'string' || !dependency) invalid(`${path}.dependsOn[${index}]`, 'must be a non-empty string');
    return dependency;
  });
  if (new Set(dependsOn).size !== dependsOn.length) invalid(`${path}.dependsOn`, 'must not contain duplicates');
  const maxAttempts = integerField(record, 'maxAttempts', path, 1, 1_000);
  const maxNoProgressAttempts = integerField(record, 'maxNoProgressAttempts', path, 1, maxAttempts);
  const lastFailure = record.lastFailure === undefined ? undefined : failureField(record.lastFailure, `${path}.lastFailure`);
  const progressSignature = optionalStringField(record, 'progressSignature', path);
  const recoveryAttempts = record.recoveryAttempts === undefined
    ? 0 : integerField(record, 'recoveryAttempts', path, 0, 1_000);
  const pendingRecovery = record.pendingRecovery === undefined
    ? undefined : pendingRecoveryField(record.pendingRecovery, `${path}.pendingRecovery`);
  let nextRetryAt: number | undefined;
  if (record.nextRetryAt !== undefined) nextRetryAt = integerField(record, 'nextRetryAt', path, 0);
  return {
    id: stringField(record, 'id', path),
    skill: stringField(record, 'skill', path),
    args: canonicalizeArgs(record.args),
    completion: completionField(record.completion, `${path}.completion`),
    dependsOn,
    status: status as PlanStepStatus,
    attempts: integerField(record, 'attempts', path, 0, maxAttempts),
    maxAttempts,
    noProgressAttempts: integerField(record, 'noProgressAttempts', path, 0, maxNoProgressAttempts),
    maxNoProgressAttempts,
    ...(recoveryAttempts > 0 ? { recoveryAttempts } : {}),
    ...(pendingRecovery ? { pendingRecovery } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    ...(progressSignature === undefined ? {} : { progressSignature }),
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
  };
}

function normalizePlan(value: unknown): MinecraftPlan {
  const normalized = normalizeJson(value);
  const record = checkRecord(normalized, '$', [
    'version', 'id', 'revision', 'goal', 'status', 'createdAt', 'updatedAt', 'steps',
  ]);
  if (record.version !== PLAN_VERSION) invalid('$.version', `must be ${PLAN_VERSION}`);
  const status = record.status;
  if (status !== 'active' && status !== 'done' && status !== 'blocked') invalid('$.status', 'is invalid');
  if (!Array.isArray(record.steps)) invalid('$.steps', 'must be an array');
  const steps = record.steps.map((step, index) => stepField(step, `$.steps[${index}]`));
  const createdAt = integerField(record, 'createdAt', '$', 0);
  const updatedAt = integerField(record, 'updatedAt', '$', 0);
  if (updatedAt < createdAt) invalid('$.updatedAt', 'must not precede createdAt');

  const earlier = new Set<string>();
  const done = new Set<string>();
  let incompleteSeen = false;
  let runningCount = 0;
  for (const [index, step] of steps.entries()) {
    const path = `$.steps[${index}]`;
    if (earlier.has(step.id)) invalid(`${path}.id`, 'must be unique');
    for (const dependency of step.dependsOn) {
      if (!earlier.has(dependency)) invalid(`${path}.dependsOn`, `must reference an earlier step (${dependency})`);
      if (step.status !== 'pending' && !done.has(dependency)) invalid(`${path}.dependsOn`, `${dependency} is not done`);
    }
    if (step.status === 'pending') {
      if (step.attempts !== 0 || step.noProgressAttempts !== 0 || step.lastFailure || step.nextRetryAt !== undefined
        || (step.recoveryAttempts ?? 0) !== 0 || step.pendingRecovery) {
        invalid(path, 'a pending step cannot have attempt failure or retry state');
      }
    } else {
      if (step.attempts < 1) invalid(`${path}.attempts`, 'must be at least 1 once started');
      for (const previous of earlier) if (!done.has(previous)) invalid(path, 'cannot follow an incomplete earlier step');
    }
    if (step.status === 'done' && incompleteSeen) invalid(path, 'a done step cannot follow an incomplete step');
    if (step.status === 'running') runningCount++;
    if (step.pendingRecovery && (step.status !== 'blocked' || step.lastFailure?.disposition !== step.pendingRecovery.disposition)) {
      invalid(`${path}.pendingRecovery`, 'must match a blocked step awaiting that recovery');
    }
    if (step.status === 'blocked') {
      if (!step.lastFailure) invalid(path, 'a blocked step must have lastFailure');
      if (step.lastFailure?.disposition === 'retry') {
        if (step.nextRetryAt === undefined) invalid(path, 'a retry must have nextRetryAt');
        if (step.attempts >= step.maxAttempts || step.noProgressAttempts >= step.maxNoProgressAttempts) {
          invalid(path, 'an exhausted retry budget cannot retain retry disposition');
        }
      } else if (step.nextRetryAt !== undefined) {
        invalid(path, 'only retry disposition may have nextRetryAt');
      }
    } else if (step.nextRetryAt !== undefined) {
      invalid(path, 'only a blocked step may have nextRetryAt');
    }
    if (step.status !== 'done') incompleteSeen = true;
    else done.add(step.id);
    earlier.add(step.id);
  }
  if (runningCount > 1) invalid('$.steps', 'must not contain more than one running step');

  const allDone = steps.length > 0 && steps.every((step) => step.status === 'done');
  if ((status === 'done') !== allDone) invalid('$.status', 'done requires a non-empty plan whose steps are all done');
  const decisionBlocked = steps.some((step) =>
    step.status === 'blocked' && (step.lastFailure?.disposition === 'needs_decision' || step.lastFailure?.disposition === 'replan'));
  if ((status === 'blocked') !== decisionBlocked) {
    invalid('$.status', 'blocked is reserved for a step requiring a decision or replan');
  }

  return {
    version: PLAN_VERSION,
    id: stringField(record, 'id', '$'),
    revision: integerField(record, 'revision', '$', 1),
    goal: stringField(record, 'goal', '$'),
    status,
    createdAt,
    updatedAt,
    steps,
  };
}

export function validatePlan(value: unknown): PlanValidationResult {
  try {
    return { ok: true, plan: normalizePlan(value) };
  } catch (error) {
    if (error instanceof PlanValidationError) return { ok: false, errors: error.errors };
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function parsePlan(value: unknown): MinecraftPlan {
  const result = validatePlan(value);
  if (!result.ok) throw new PlanValidationError(result.errors);
  return result.plan;
}

/** Stable handoff content, excluding execution state, timestamps and revision. */
export function planDefinition(planValue: MinecraftPlan): JsonObject {
  const plan = parsePlan(planValue);
  return normalizeJson({
    goal: plan.goal,
    steps: plan.steps.map((step) => ({
      id: step.id,
      skill: step.skill,
      args: step.args,
      completion: step.completion,
      dependsOn: [...step.dependsOn],
      maxAttempts: step.maxAttempts,
      maxNoProgressAttempts: step.maxNoProgressAttempts,
    })),
  }) as JsonObject;
}

/** Create a new pending plan. Generated step IDs are stable array positions. */
export function createPlan(goal: string, steps: PlanStepDraft[], options: PlanIdAndTime = {}): MinecraftPlan {
  if (typeof goal !== 'string' || !goal.trim()) invalid('$.goal', 'must be a non-empty string');
  if (!Array.isArray(steps)) invalid('$.steps', 'must be an array');
  const normalizedSteps = normalizeJson(steps, '$.steps');
  if (!Array.isArray(normalizedSteps)) invalid('$.steps', 'must be an array');
  const records = normalizedSteps.map((step, index) => checkRecord(step, `$.steps[${index}]`, [
    'id', 'skill', 'args', 'completion', 'dependsOn', 'maxAttempts', 'maxNoProgressAttempts',
  ]));
  const ids = records.map((record, index) => record.id === undefined
    ? `step-${index + 1}`
    : stringField(record, 'id', `$.steps[${index}]`));
  const id = options.id ?? randomUUID();
  const now = options.now ?? Date.now();
  return parsePlan({
    version: PLAN_VERSION,
    id,
    revision: 1,
    goal: goal.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    steps: records.map((record, index) => {
      const path = `$.steps[${index}]`;
      const maxAttempts = record.maxAttempts === undefined
        ? DEFAULT_MAX_ATTEMPTS
        : integerField(record, 'maxAttempts', path, 1, 1_000);
      const maxNoProgressAttempts = record.maxNoProgressAttempts === undefined
        ? Math.min(DEFAULT_MAX_NO_PROGRESS_ATTEMPTS, maxAttempts)
        : integerField(record, 'maxNoProgressAttempts', path, 1, maxAttempts);
      return {
        id: ids[index],
        skill: stringField(record, 'skill', path),
        args: record.args === undefined ? {} : canonicalizeArgs(record.args),
        completion: record.completion,
        dependsOn: record.dependsOn ?? (index === 0 ? [] : [ids[index - 1]]),
        status: 'pending',
        attempts: 0,
        maxAttempts,
        noProgressAttempts: 0,
        maxNoProgressAttempts,
      };
    }),
  });
}

/**
 * A text goal has no executable evidence, so migration intentionally leaves it
 * active with zero steps. In particular, an empty legacy plan is not done.
 */
export function wrapLegacyGoal(goal: string, options: PlanIdAndTime = {}): MinecraftPlan {
  return createPlan(goal, [], options);
}

/** Accept a current plan, a structured draft, a text goal, or a legacy journal with goal. */
export function migratePlan(payload: unknown, options: PlanIdAndTime = {}): MinecraftPlan {
  if (typeof payload === 'string') return wrapLegacyGoal(payload, options);
  if (isRecord(payload) && payload.version === PLAN_VERSION) return parsePlan(payload);
  if (isRecord(payload) && payload.version === undefined && typeof payload.goal === 'string') {
    if (payload.steps === undefined) return wrapLegacyGoal(payload.goal, options);
    if (Array.isArray(payload.steps)) return createPlan(payload.goal, payload.steps as PlanStepDraft[], options);
  }
  throw new PlanValidationError(['payload is not a current plan, structured draft, or legacy goal']);
}

function samePosition(a: WorldPosition, b: WorldPosition): boolean {
  return a.dimension === b.dimension && a.x === b.x && a.y === b.y && a.z === b.z;
}

function validPosition(value: unknown): value is WorldPosition {
  return isRecord(value) && typeof value.dimension === 'string'
    && ['x', 'y', 'z'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

/** Evaluate only typed evidence. Missing or malformed evidence is unknown, never success. */
export function evaluateCompletion(predicate: CompletionPredicate, observation: CompletionObservation): TriState {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return 'unknown';
  switch (predicate.type) {
    case 'inventory_at_least': {
      if (!observation.inventory || !isRecord(observation.inventory)) return 'unknown';
      const count = observation.inventory[predicate.item] ?? 0;
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return 'unknown';
      return count >= predicate.count ? 'met' : 'unmet';
    }
    case 'block_light_at_least': {
      const samples = Array.isArray(observation.blockLight) ? observation.blockLight : [];
      const sample = samples.find((candidate) => validPosition(candidate) && samePosition(candidate, predicate.position));
      if (!sample || sample.loaded !== true) return 'unknown';
      if (typeof sample.blockLight !== 'number' || !Number.isFinite(sample.blockLight)) return 'unknown';
      return sample.blockLight >= predicate.minimum ? 'met' : 'unmet';
    }
    case 'near_position': {
      const position = observation.position;
      if (!validPosition(position)) return 'unknown';
      if (position.dimension !== predicate.position.dimension) return 'unmet';
      const dx = position.x - predicate.position.x;
      const dy = position.y - predicate.position.y;
      const dz = position.z - predicate.position.z;
      return dx * dx + dy * dy + dz * dz <= predicate.radius * predicate.radius ? 'met' : 'unmet';
    }
    case 'blueprint_complete': {
      const blueprint = observation.blueprints?.[predicate.blueprintId];
      if (!blueprint || !Number.isSafeInteger(blueprint.remaining) || !Number.isSafeInteger(blueprint.unloaded)
        || blueprint.remaining < 0 || blueprint.unloaded < 0) return 'unknown';
      if (blueprint.remaining > 0) return 'unmet';
      return blueprint.unloaded > 0 ? 'unknown' : 'met';
    }
    case 'all_of': {
      let unknown = false;
      for (const child of predicate.predicates) {
        const state = evaluateCompletion(child, observation);
        if (state === 'unmet') return 'unmet';
        if (state === 'unknown') unknown = true;
      }
      return unknown ? 'unknown' : 'met';
    }
  }
}

/** No jitter: attempt 1 waits baseMs, attempt 2 waits 2x, and so on up to maxMs. */
export function retryBackoffMs(attempts: number, options: RetryBackoff = {}): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive safe integer');
  const baseMs = options.baseMs ?? DEFAULT_RETRY_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_RETRY_MAX_MS;
  if (!Number.isSafeInteger(baseMs) || baseMs < 0 || !Number.isSafeInteger(maxMs) || maxMs < 0) {
    throw new RangeError('backoff baseMs and maxMs must be non-negative safe integers');
  }
  if (baseMs === 0 || maxMs === 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts - 1, 1_024));
}

function checkedTransitionTime(plan: MinecraftPlan, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new PlanTransitionError('now must be a non-negative safe integer');
  if (now < plan.updatedAt) throw new PlanTransitionError('now must not move the plan timestamp backwards');
}

function touch(plan: MinecraftPlan, now: number): void {
  plan.revision++;
  plan.updatedAt = now;
}

export function beginStep(planValue: MinecraftPlan, stepId: string, options: BeginStepOptions): MinecraftPlan {
  const plan = parsePlan(planValue);
  checkedTransitionTime(plan, options.now);
  if (plan.status !== 'active') throw new PlanTransitionError(`cannot begin a step in ${plan.status} plan`);
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new PlanTransitionError(`unknown step ${stepId}`);
  const step = plan.steps[index];
  if (plan.steps.slice(0, index).some((previous) => previous.status !== 'done')) {
    throw new PlanTransitionError(`step ${stepId} has an incomplete earlier step`);
  }
  if (step.dependsOn.some((id) => plan.steps.find((candidate) => candidate.id === id)?.status !== 'done')) {
    throw new PlanTransitionError(`step ${stepId} has an unmet dependency`);
  }
  if (step.status === 'blocked') {
    const disposition = step.lastFailure?.disposition;
    if (disposition === 'supply' || disposition === 'reroute' || disposition === 'defence') {
      if (options.recovered !== true) throw new PlanTransitionError(`step ${stepId} requires a completed ${disposition} recovery`);
    } else if (disposition === 'retry') {
      if (options.recovered === true) throw new PlanTransitionError(`step ${stepId} is retryable, not awaiting recovery`);
      if (step.nextRetryAt === undefined || options.now < step.nextRetryAt) throw new PlanTransitionError(`step ${stepId} is cooling down`);
    } else {
      throw new PlanTransitionError(`step ${stepId} is not automatically retryable`);
    }
  } else if (step.status !== 'pending') {
    throw new PlanTransitionError(`cannot begin a ${step.status} step`);
  }
  if (step.attempts >= step.maxAttempts || step.noProgressAttempts >= step.maxNoProgressAttempts) {
    throw new PlanTransitionError(`step ${stepId} has exhausted its retry budget`);
  }
  step.status = 'running';
  step.attempts++;
  delete step.nextRetryAt;
  delete step.pendingRecovery;
  if (options.progress !== undefined) step.progressSignature = canonicalJson(options.progress);
  touch(plan, options.now);
  return plan;
}

/** Completing a running step always re-evaluates its typed predicate. */
export function completeStep(
  planValue: MinecraftPlan,
  stepId: string,
  observation: CompletionObservation,
  options: { now: number },
): MinecraftPlan {
  const plan = parsePlan(planValue);
  checkedTransitionTime(plan, options.now);
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new PlanTransitionError(`unknown step ${stepId}`);
  if (step.status !== 'running') throw new PlanTransitionError(`cannot complete a ${step.status} step`);
  const completion = evaluateCompletion(step.completion, observation);
  if (completion !== 'met') throw new PlanTransitionError(`step ${stepId} completion is ${completion}, not met`);
  step.status = 'done';
  delete step.nextRetryAt;
  plan.status = plan.steps.length > 0 && plan.steps.every((candidate) => candidate.status === 'done') ? 'done' : 'active';
  touch(plan, options.now);
  return plan;
}

export function failStep(planValue: MinecraftPlan, stepId: string, report: FailStepReport): MinecraftPlan {
  const plan = parsePlan(planValue);
  checkedTransitionTime(plan, report.now);
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new PlanTransitionError(`unknown step ${stepId}`);
  if (step.status !== 'running') throw new PlanTransitionError(`cannot fail a ${step.status} step`);
  if (typeof report.code !== 'string' || !report.code.trim()) throw new PlanTransitionError('failure code must be non-empty');
  if (report.message !== undefined && typeof report.message !== 'string') throw new PlanTransitionError('failure message must be text');
  const requested = dispositionField(report.disposition, '$.failure.disposition');
  const certainty = report.certainty ?? 'certain';
  if (certainty !== 'certain' && certainty !== 'uncertain') throw new PlanTransitionError('invalid result certainty');
  const idempotent = report.idempotent ?? false;
  if (typeof idempotent !== 'boolean') throw new PlanTransitionError('idempotent must be boolean');
  const recoveryAttempts = report.recoveryAttempts ?? step.recoveryAttempts ?? 0;
  if (!Number.isSafeInteger(recoveryAttempts) || recoveryAttempts < (step.recoveryAttempts ?? 0) || recoveryAttempts > 1_000) {
    throw new PlanTransitionError('recoveryAttempts must be a nondecreasing safe integer within budget');
  }
  const action = report.action ?? step.skill;
  if (typeof action !== 'string' || !action) throw new PlanTransitionError('failure action must be non-empty');
  if (report.recovery && report.recovery.disposition !== requested) {
    throw new PlanTransitionError('recovery disposition must match the failure disposition');
  }
  const pendingRecovery = report.recovery
    ? pendingRecoveryField({ ...report.recovery, started: false }, '$.failure.recovery')
    : undefined;
  const fingerprint = canonicalFingerprint({
    planId: plan.id,
    stepId: step.id,
    action,
    target: report.target ?? step.args,
    context: report.context ?? null,
  });

  const previousProgress = step.progressSignature;
  const currentProgress = report.progress === undefined ? previousProgress : canonicalJson(report.progress);
  const madeProgress = previousProgress !== undefined && currentProgress !== undefined && previousProgress !== currentProgress;
  const sameFailure = step.lastFailure?.fingerprint === fingerprint;
  const sameProgress = currentProgress === previousProgress && currentProgress === step.lastFailure?.progressSignature;
  const noProgressAttempts = madeProgress ? 0 : sameFailure && sameProgress ? step.noProgressAttempts + 1 : 1;

  let disposition = requested;
  const automatic = requested === 'retry' || requested === 'supply' || requested === 'defence' || requested === 'reroute';
  if (certainty === 'uncertain' && !idempotent) disposition = 'needs_decision';
  else if (automatic && step.attempts >= step.maxAttempts) disposition = 'needs_decision';
  else if (automatic && noProgressAttempts >= step.maxNoProgressAttempts) disposition = 'replan';

  let nextRetryAt: number | undefined;
  if (disposition === 'retry') {
    const delay = retryBackoffMs(step.attempts, report.backoff);
    if (!Number.isSafeInteger(report.now + delay)) throw new PlanTransitionError('next retry timestamp overflows');
    nextRetryAt = report.now + delay;
  }
  step.status = 'blocked';
  step.noProgressAttempts = noProgressAttempts;
  if (recoveryAttempts > 0) step.recoveryAttempts = recoveryAttempts;
  if (currentProgress !== undefined) step.progressSignature = currentProgress;
  delete step.pendingRecovery;
  if (pendingRecovery && pendingRecovery.disposition === disposition) step.pendingRecovery = pendingRecovery;
  if (nextRetryAt === undefined) delete step.nextRetryAt;
  else step.nextRetryAt = nextRetryAt;
  step.lastFailure = {
    at: report.now,
    code: report.code,
    ...(report.message === undefined ? {} : { message: report.message }),
    disposition,
    fingerprint,
    certainty,
    idempotent,
    ...(currentProgress === undefined ? {} : { progressSignature: currentProgress }),
  };
  plan.status = disposition === 'needs_decision' || disposition === 'replan' ? 'blocked' : 'active';
  touch(plan, report.now);
  return plan;
}

/** Persist the dispatch barrier before a recovery action reaches the worker. */
export function markRecoveryStarted(planValue: MinecraftPlan, stepId: string, options: { now: number }): MinecraftPlan {
  const plan = parsePlan(planValue);
  checkedTransitionTime(plan, options.now);
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step?.pendingRecovery || step.status !== 'blocked') throw new PlanTransitionError(`step ${stepId} has no pending recovery`);
  if (step.pendingRecovery.started) return plan;
  step.pendingRecovery.started = true;
  touch(plan, options.now);
  return plan;
}

/** Re-arm only an idempotent recovery after a process/worker interruption. */
export function resetRecoveryStarted(planValue: MinecraftPlan, stepId: string, options: { now: number }): MinecraftPlan {
  const plan = parsePlan(planValue);
  checkedTransitionTime(plan, options.now);
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step?.pendingRecovery || step.status !== 'blocked') throw new PlanTransitionError(`step ${stepId} has no pending recovery`);
  if (!step.pendingRecovery.idempotent) throw new PlanTransitionError('a non-idempotent started recovery cannot be re-armed');
  if (!step.pendingRecovery.started) return plan;
  step.pendingRecovery.started = false;
  touch(plan, options.now);
  return plan;
}

/** A failed/cancelled recovery never silently becomes proof that the original step recovered. */
export function failRecovery(
  planValue: MinecraftPlan,
  stepId: string,
  report: Omit<FailStepReport, 'recovery'>,
): MinecraftPlan {
  const plan = parsePlan(planValue);
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  const pending = step?.pendingRecovery;
  if (!step || !pending || step.status !== 'blocked') throw new PlanTransitionError(`step ${stepId} has no pending recovery`);
  const intermediate: MinecraftPlan = {
    ...plan,
    steps: plan.steps.map((candidate) => {
      if (candidate.id !== stepId) return candidate;
      const { pendingRecovery: _pendingRecovery, nextRetryAt: _nextRetryAt, ...rest } = candidate;
      return { ...rest, status: 'running' };
    }),
  };
  return failStep(intermediate, stepId, {
    ...report,
    action: `recovery:${pending.bodyAction}`,
    target: report.target ?? pending.args,
    idempotent: report.idempotent ?? pending.idempotent,
    disposition: report.disposition ?? 'needs_decision',
  });
}
