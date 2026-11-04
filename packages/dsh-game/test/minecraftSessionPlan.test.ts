import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinecraftSession } from '../src/games/minecraft/session.js';
import { WorldJournal } from '../src/games/minecraft/journal.js';
import type {
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
  MinecraftFact,
} from '../src/games/minecraft/body/contracts.js';
import type { GameAction, RunEvent } from '../src/games/types.js';
import type { MinecraftPlan } from '../src/games/minecraft/plan.js';

interface PendingAction {
  id: string;
  name: string;
  args: Record<string, unknown>;
  resolve(result: MinecraftActionResult): void;
  reject(error: Error): void;
}

class FakeRuntime {
  snapshot = environment();
  readonly commands: Array<{ action: string; payload: Record<string, unknown> }> = [];
  readonly actions: PendingAction[] = [];

  command<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    this.commands.push({ action, payload });
    if (action === 'execute-action') {
      let resolve!: (result: MinecraftActionResult) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<MinecraftActionResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.actions.push({
        id: String(payload.id), name: String(payload.name), args: payload.args as Record<string, unknown>, resolve, reject,
      });
      return promise as Promise<T>;
    }
    if (action === 'snapshot') return Promise.resolve(this.snapshot as T);
    if (action === 'status') {
      return Promise.resolve({
        connected: true, username: 'DaFeiYu', players: ['DaFeiYu'], spectators: [], version: '1.20.4',
      } as T);
    }
    if (action === 'cancel-action') return Promise.resolve(true as T);
    return Promise.resolve({} as T);
  }
}

interface Fixture {
  session: MinecraftSession;
  internal: any;
  runtime: FakeRuntime;
  events: RunEvent[];
  plan(): MinecraftPlan | null;
  respond(
    action: PendingAction,
    result?: Partial<MinecraftActionResult>,
    settle?: boolean,
  ): Promise<void>;
  settle(action: PendingAction): Promise<void>;
}

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-minecraft-session-plan-'));
  directories.push(directory);
  return directory;
}

function fixture(journalDir?: string): Fixture {
  const runtime = new FakeRuntime();
  const events: RunEvent[] = [];
  const session = new MinecraftSession({
    workerPath: 'unused', host: '127.0.0.1', port: 25565, username: 'DaFeiYu',
    record: (event) => events.push(event), rcon: null, camera: null, journalDir: null,
  });
  const internal = session as any;
  internal.runtime = runtime;
  internal.status = {
    connected: true, username: 'DaFeiYu', players: ['DaFeiYu'], spectators: [], version: '1.20.4',
  };
  internal.snapshot = runtime.snapshot;
  if (journalDir) {
    internal.journal = WorldJournal.open(journalDir, '127.0.0.1:25565', 'DaFeiYu').journal;
    internal.plan = internal.journal.activePlan ?? null;
    internal.planMode = internal.journal.planMode;
    internal.goal = internal.journal.goal;
    internal.journal.startSession();
  }
  const settle = async (action: PendingAction): Promise<void> => {
    internal.onBodyEvent({ kind: 'action-handler-settled', actionId: action.id });
    await flush();
  };
  return {
    session, internal, runtime, events,
    plan: () => internal.plan as MinecraftPlan | null,
    respond: async (action, overrides = {}, shouldSettle = true) => {
      action.resolve(result(action.id, overrides));
      await flush();
      if (shouldSettle) await settle(action);
    },
    settle,
  };
}

function environment(overrides: Record<string, any> = {}): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: 100,
    stale: false,
    connection: { connected: true, username: 'DaFeiYu', host: '127.0.0.1', port: 25565 },
    world: { dimension: 'overworld', timeOfDay: 13_000, ...overrides.world },
    lighting: { loaded: true, blockLight: 0, skyLight: 0, canSeeSky: false, sampledAt: 100, ...overrides.lighting },
    body: {
      position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: {}, ...overrides.body,
    },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [], ...overrides.nearby },
    recentEvents: [],
  };
}

function result(id: string, overrides: Partial<MinecraftActionResult> = {}): MinecraftActionResult {
  return {
    actionId: id,
    outcome: 'succeeded',
    summary: 'worker summary claims success',
    durationMs: 1,
    inventoryDelta: {},
    worldChanges: [],
    observations: [],
    ...overrides,
  };
}

function failure(code: string, details: Record<string, unknown> = {}, recoverable = true): Partial<MinecraftActionResult> {
  return {
    outcome: 'failed', summary: `failed: ${code}`,
    error: { code: code as any, recoverable, details },
  };
}

function planAction(
  id: string,
  skill: string,
  args: Record<string, unknown>,
  completion: Record<string, unknown>,
  mode: 'active' | 'shadow' = 'active',
): GameAction {
  return {
    action: 'plan',
    data: {
      id, mode, goal: `goal for ${id}`,
      steps: [{ id: 'main', skill, args, completion }],
    },
  };
}

function inventoryCompletion(count = 4): Record<string, unknown> {
  return { type: 'inventory_at_least', item: 'torch', count };
}

function lightCompletion(x = 0): Record<string, unknown> {
  return {
    type: 'block_light_at_least', minimum: 8,
    position: { x, y: 64, z: 0, dimension: 'overworld' },
  };
}

function buildEvidence(data: {
  completed: number;
  remaining: unknown[];
  remainingClear: unknown[];
  unloaded: number;
  temporaryBlocks?: unknown[];
}): MinecraftFact[] {
  return [{
    id: 'build-evidence', at: 100, severity: 'info', kind: 'build-evidence', text: 'real world diff',
    data: { temporaryBlocks: [], ...data },
  }];
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('active structured plans use one settled queue', () => {
  it('waits for handler settlement and completes only from a refreshed real inventory', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    await session.act(planAction('torches', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));

    expect(runtime.actions.map(({ name }) => name)).toEqual(['craft_item']);
    const action = runtime.actions[0];
    runtime.snapshot = environment({ body: { inventory: { torch: 4 } } });
    await f.respond(action, {}, false);

    expect(internal.running?.id).toBe(action.id);
    expect(plan()?.steps[0].status).toBe('running');
    expect(runtime.commands.filter(({ action: name }) => name === 'snapshot')).toHaveLength(0);
    expect(f.events.some((event) => event.type === 'minecraft_action' && event.phase === 'settled')).toBe(false);

    await f.settle(action);
    expect(plan()?.status).toBe('done');
    expect(runtime.actions).toHaveLength(1);
    expect(runtime.commands.filter(({ action: name }) => name === 'snapshot')).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'minecraft_action')).toEqual([
      expect.objectContaining({
        type: 'minecraft_action', phase: 'started', runId: action.id, actionId: action.id,
        action: 'craft_item', planId: 'torches', stepId: 'main', attempt: 1,
      }),
      expect.objectContaining({
        type: 'minecraft_action', phase: 'settled', runId: action.id, actionId: action.id,
        action: 'craft_item', outcome: 'succeeded', certainty: 'certain',
      }),
    ]);
    expect(f.events.filter((event) => event.type === 'minecraft_plan').at(-1)).toMatchObject({
      type: 'minecraft_plan', planId: 'torches', status: 'done',
      steps: [{ id: 'main', status: 'done', attempts: 1 }],
    });
  });

  it('does not accept a success summary as proof for an unchanged inventory', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    await session.act(planAction('torches', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));
    await f.respond(runtime.actions[0]);

    expect(plan()?.status).toBe('blocked');
    expect(plan()?.steps[0].lastFailure).toMatchObject({
      code: 'postcondition_unmet', disposition: 'needs_decision', certainty: 'certain', idempotent: false,
    });
    expect(runtime.actions).toHaveLength(1);
  });

  it('bounds an idempotent successful action that makes no real lighting progress', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    await session.act(planAction('light', 'ensure_lighting', {}, lightCompletion()));
    await f.respond(runtime.actions[0]);

    expect(plan()?.steps[0]).toMatchObject({
      status: 'blocked',
      lastFailure: { code: 'postcondition_unmet', disposition: 'retry', idempotent: true },
    });
    expect(runtime.actions).toHaveLength(1);
    internal.pumpQueue();
    expect(runtime.actions).toHaveLength(1);
  });

  it('treats unloaded lighting as unknown even when the adapter includes a numeric value', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    runtime.snapshot = environment({ lighting: { loaded: false, blockLight: 15 } });
    internal.snapshot = runtime.snapshot;
    await session.act(planAction('unknown-light', 'ensure_lighting', {}, lightCompletion()));

    expect(runtime.actions).toHaveLength(1);
    await f.respond(runtime.actions[0]);
    expect(plan()?.steps[0].lastFailure).toMatchObject({ code: 'completion_unknown', disposition: 'retry' });
    expect(plan()?.status).not.toBe('done');
  });

  it('uses only the current body light sample, never a nearby position, in shadow mode', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    runtime.snapshot = environment({ lighting: { blockLight: 15 } });
    internal.snapshot = runtime.snapshot;
    await session.act(planAction('shadow-light', 'ensure_lighting', {}, lightCompletion(99), 'shadow'));

    expect(runtime.actions).toHaveLength(0);
    expect(plan()?.steps[0].status).toBe('pending');
    expect(plan()?.status).toBe('active');
  });

  it('accepts a remote target only from the action\'s bounded per-cell lighting scan', async () => {
    const f = fixture();
    const { session, runtime, plan } = f;
    await session.act(planAction('remote-light', 'ensure_lighting', {}, lightCompletion(5)));
    await f.respond(runtime.actions[0], {
      observations: [{
        id: 'scan-1', at: 100, severity: 'info', kind: 'lighting-evidence', text: 'real scan',
        data: {
          samples: [
            { x: 5, y: 64, z: 0, dimension: 'overworld', loaded: true, blockLight: 9 },
            { x: 6, y: 64, z: 0, dimension: 'overworld', loaded: false, blockLight: null },
          ],
        },
      }],
    });

    expect(plan()?.status).toBe('done');
    expect(plan()?.steps[0].status).toBe('done');
  });

  it('lets shadow mode consume already true real evidence without dispatching an action', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    runtime.snapshot = environment({ body: { inventory: { torch: 4 } } });
    internal.snapshot = runtime.snapshot;
    await session.act(planAction('shadow-stock', 'ensure_torches', { targetCount: 4 }, inventoryCompletion(), 'shadow'));

    await flush();
    expect(runtime.actions).toHaveLength(0);
    expect(plan()?.status).toBe('done');
  });
});

describe('persistent recovery and handoff ownership', () => {
  it('persists supply recovery before dispatch and revalidates the original goal after success', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    await session.act(planAction('supply', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));
    await f.respond(runtime.actions[0], failure('missing_item', { item: 'coal', quantity: 1 }));

    expect(plan()?.steps[0]).toMatchObject({
      status: 'blocked', recoveryAttempts: 1,
      pendingRecovery: { disposition: 'supply', bodyAction: 'collect_item', started: false },
    });
    internal.recoveryAt = 0;
    internal.pumpQueue();
    internal.pumpQueue();
    expect(runtime.actions.map(({ name }) => name)).toEqual(['craft_item', 'collect_item']);
    expect(plan()?.steps[0].pendingRecovery?.started).toBe(true);

    runtime.snapshot = environment({ body: { inventory: { coal: 1, torch: 4 } } });
    await f.respond(runtime.actions[1]);
    expect(plan()?.status).toBe('done');
    expect(plan()?.steps[0].attempts).toBe(2);
    expect(plan()?.steps[0].pendingRecovery).toBeUndefined();
    expect(runtime.actions).toHaveLength(2);
  });

  it('does not treat failed supply as recovery or replay the original non-idempotent craft', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    await session.act(planAction('supply-fails', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));
    await f.respond(runtime.actions[0], failure('missing_item', { item: 'coal', quantity: 1 }));
    internal.recoveryAt = 0;
    internal.pumpQueue();

    await f.respond(runtime.actions[1], failure('timeout'));
    expect(plan()?.status).toBe('blocked');
    expect(plan()?.steps[0].lastFailure).toMatchObject({ disposition: 'needs_decision' });
    expect(plan()?.steps[0].pendingRecovery).toBeUndefined();
    expect(runtime.actions).toHaveLength(2);
  });

  it('never turns an uncertain non-idempotent timeout into automatic recovery or replay', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    await session.act(planAction('uncertain-craft', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));
    await f.respond(runtime.actions[0], failure('timeout'));

    expect(plan()?.status).toBe('blocked');
    expect(plan()?.steps[0].lastFailure).toMatchObject({
      code: 'timeout', disposition: 'needs_decision', certainty: 'uncertain', idempotent: false,
    });
    expect(plan()?.steps[0].pendingRecovery).toBeUndefined();
    expect(runtime.actions).toHaveLength(1);
  });

  it('honours worker-declared uncertainty instead of recovering a non-idempotent action from its error code', async () => {
    const f = fixture();
    const { session, runtime, plan } = f;
    await session.act(planAction('declared-uncertain', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));
    await f.respond(runtime.actions[0], {
      ...failure('missing_item', { item: 'coal', quantity: 1 }),
      certainty: 'uncertain',
    });

    expect(plan()?.status).toBe('blocked');
    expect(plan()?.steps[0].lastFailure).toMatchObject({
      code: 'missing_item', disposition: 'needs_decision', certainty: 'uncertain', idempotent: false,
    });
    expect(plan()?.steps[0].pendingRecovery).toBeUndefined();
    expect(runtime.actions).toHaveLength(1);
  });

  it('deduplicates handoffs in memory and never lets an old receipt replace the current plan', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    runtime.snapshot = environment({ body: { inventory: { torch: 4 } } });
    internal.snapshot = runtime.snapshot;
    const first = planAction('handoff-a', 'ensure_torches', { targetCount: 4 }, inventoryCompletion(), 'shadow');
    await session.act(first);
    await flush();
    expect(await session.act(first)).toContain('不会重复创建');

    const changed = planAction('handoff-a', 'ensure_torches', { targetCount: 5 }, inventoryCompletion(5), 'shadow');
    expect(await session.act(changed)).toContain('另一份计划');
    await session.act(planAction('handoff-b', 'ensure_torches', { targetCount: 4 }, inventoryCompletion(), 'shadow'));
    expect(plan()?.id).toBe('handoff-b');

    expect(await session.act(first)).toContain('不会重复执行或替换当前计划');
    expect(plan()?.id).toBe('handoff-b');
    expect(runtime.actions).toHaveLength(0);
  });

  it('records an urgent replacement before dropping every stale outcome from the old action', async () => {
    const f = fixture();
    const { session, internal, runtime, plan } = f;
    runtime.snapshot = environment({
      body: { inventory: { torch: 4, iron_sword: 1 } },
      nearby: { entities: [{ name: 'zombie', type: 'hostile', position: { x: 2, y: 64, z: 0 }, distance: 2, hostile: true }] },
    });
    internal.snapshot = runtime.snapshot;
    await session.act(planAction('urgent', 'ensure_lighting', {}, lightCompletion()));
    const old = runtime.actions[0];

    const urgent = session.act({ action: 'attack', name: 'zombie' });
    await flush();
    await f.respond(old, {}, true);
    await urgent;

    expect(plan()?.steps[0].lastFailure).toMatchObject({ code: 'cancelled', disposition: 'retry' });
    expect(runtime.actions.map(({ name }) => name)).toEqual(['ensure_lighting', 'attack_entity']);
    expect(plan()?.steps[0].status).toBe('blocked');
  });
});

describe('plan-owned blueprint evidence', () => {
  it('requires clear cells and loaded chunks before completing and clearing the persistent job', async () => {
    const directory = temporaryDirectory();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(directory);
    const { session, internal, runtime, plan } = f;
    const block = { x: 0, y: 64, z: 0, name: 'stone', props: {} };
    const clear = { x: 0, y: 65, z: 0 };
    await session.act(planAction('build', 'build_resume', {
      blueprintId: 'cabin', origin: { x: 0, y: 64, z: 0 }, blocks: [block], clear: [clear],
    }, { type: 'blueprint_complete', blueprintId: 'cabin' }));

    expect(runtime.actions).toHaveLength(1);
    expect(runtime.actions[0].name).toBe('build_structure');
    expect(runtime.actions[0].args).not.toHaveProperty('origin');
    expect(internal.journal.activeJob).toMatchObject({ planId: 'build', stepId: 'main', attempts: 1 });

    await f.respond(runtime.actions[0], {
      observations: buildEvidence({ completed: 1, remaining: [], remainingClear: [clear], unloaded: 0 }),
    });
    expect(plan()?.steps[0].status).toBe('running');
    expect(internal.journal.activeJob).toBeDefined();
    expect(runtime.actions).toHaveLength(2);

    await f.respond(runtime.actions[1], {
      observations: buildEvidence({ completed: 1, remaining: [], remainingClear: [], unloaded: 1 }),
    });
    expect(plan()?.steps[0]).toMatchObject({
      status: 'blocked', lastFailure: { code: 'completion_unknown', disposition: 'retry' },
    });
    expect(internal.journal.activeJob).toBeDefined();
    expect(runtime.actions).toHaveLength(2);

    now += 31_000;
    internal.recoveryAt = 0;
    internal.pumpQueue();
    expect(plan()?.steps[0].status).toBe('running');
    expect(runtime.actions).toHaveLength(3);

    await f.respond(runtime.actions[2], {
      observations: buildEvidence({ completed: 1, remaining: [], remainingClear: [], unloaded: 0 }),
    });
    expect(plan()?.status).toBe('done');
    expect(internal.journal.activeJob).toBeUndefined();
    expect(runtime.actions).toHaveLength(3);
  });
});

describe('restart and explicit build lifecycle', () => {
  it('does not replay a persisted running non-idempotent craft after an abrupt restart', async () => {
    const directory = temporaryDirectory();
    const first = fixture(directory);
    await first.session.act(planAction('restart-craft', 'ensure_torches', { targetCount: 4 }, inventoryCompletion()));
    expect(first.internal.journal.activePlan.steps[0].status).toBe('running');

    const restarted = fixture(directory);
    restarted.internal.restorePersistedPlan();
    restarted.internal.restorePersistedWork();
    restarted.internal.pumpQueue();

    expect(restarted.plan()?.steps[0]).toMatchObject({
      status: 'blocked',
      lastFailure: { code: 'interrupted', disposition: 'needs_decision', certainty: 'uncertain', idempotent: false },
    });
    expect(restarted.runtime.actions).toHaveLength(0);
  });

  it('persists a started defence barrier and never replays it after restart with an unknown outcome', async () => {
    const directory = temporaryDirectory();
    const first = fixture(directory);
    first.runtime.snapshot = environment({
      body: { inventory: { torch: 4, iron_sword: 1 } },
      nearby: { entities: [{ name: 'zombie', type: 'hostile', position: { x: 2, y: 64, z: 0 }, distance: 2, hostile: true }] },
    });
    first.internal.snapshot = first.runtime.snapshot;
    await first.session.act(planAction('restart-defence', 'ensure_lighting', {}, lightCompletion()));
    await first.respond(first.runtime.actions[0], failure('unsafe', {
      requirement: 'clear-hostiles', entity: 'zombie',
    }));
    first.internal.recoveryAt = 0;
    first.internal.pumpQueue();

    expect(first.runtime.actions.map(({ name }) => name)).toEqual(['ensure_lighting', 'attack_entity']);
    expect(first.internal.journal.activePlan.steps[0].pendingRecovery).toMatchObject({
      bodyAction: 'attack_entity', idempotent: false, started: true,
    });

    const restarted = fixture(directory);
    restarted.internal.restorePersistedPlan();
    restarted.internal.pumpQueue();

    expect(restarted.plan()?.status).toBe('blocked');
    expect(restarted.plan()?.steps[0].lastFailure).toMatchObject({
      code: 'interrupted', disposition: 'needs_decision', certainty: 'uncertain',
    });
    expect(restarted.plan()?.steps[0].pendingRecovery).toBeUndefined();
    expect(restarted.runtime.actions).toHaveLength(0);
  });

  it('resumes a persisted build only through its owning plan step after restart', async () => {
    const directory = temporaryDirectory();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = fixture(directory);
    await first.session.act(planAction('restart-build', 'build_resume', {
      blueprintId: 'cabin', origin: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 64, z: 0, name: 'stone', props: {} }], clear: [],
    }, { type: 'blueprint_complete', blueprintId: 'cabin' }));
    expect(first.internal.journal.activeJob).toMatchObject({ planId: 'restart-build', attempts: 1 });

    const restarted = fixture(directory);
    restarted.internal.restorePersistedPlan();
    restarted.internal.restorePersistedWork();
    expect(restarted.internal.queue).toHaveLength(0);
    expect(restarted.runtime.actions).toHaveLength(0);
    expect(restarted.plan()?.steps[0].lastFailure).toMatchObject({ code: 'interrupted', disposition: 'retry' });

    now += 2_000;
    restarted.internal.pumpQueue();
    expect(restarted.runtime.actions).toHaveLength(1);
    expect(restarted.runtime.actions[0].name).toBe('build_structure');
    expect(restarted.internal.journal.activeJob).toMatchObject({
      planId: 'restart-build', stepId: 'main', attempts: 2,
    });
  });

  it('stop switches to shadow and preserves the job even if the stale builder reports success', async () => {
    const directory = temporaryDirectory();
    const f = fixture(directory);
    await f.session.act(planAction('stop-build', 'build_resume', {
      blueprintId: 'cabin', origin: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 64, z: 0, name: 'stone', props: {} }], clear: [],
    }, { type: 'blueprint_complete', blueprintId: 'cabin' }));

    const stopping = f.session.act({ action: 'stop' });
    await flush();
    await f.respond(f.runtime.actions[0], {
      observations: buildEvidence({ completed: 1, remaining: [], remainingClear: [], unloaded: 0 }),
    });
    await stopping;

    expect(f.internal.planMode).toBe('shadow');
    expect(f.plan()?.steps[0].lastFailure).toMatchObject({ code: 'cancelled', disposition: 'retry' });
    expect(f.internal.journal.activeJob).toMatchObject({ planId: 'stop-build', phase: 'RECOVERING' });
    expect(f.runtime.actions).toHaveLength(1);
  });

  it('abandon alone clears the job and turns the old running step into a replan decision', async () => {
    const directory = temporaryDirectory();
    const f = fixture(directory);
    await f.session.act(planAction('abandon-build', 'build_resume', {
      blueprintId: 'cabin', origin: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 64, z: 0, name: 'stone', props: {} }], clear: [],
    }, { type: 'blueprint_complete', blueprintId: 'cabin' }));

    const abandoning = f.session.act({ action: 'abandon' });
    await flush();
    await f.respond(f.runtime.actions[0], {
      observations: buildEvidence({ completed: 1, remaining: [], remainingClear: [], unloaded: 0 }),
    });
    await abandoning;

    expect(f.internal.journal.activeJob).toBeUndefined();
    expect(f.plan()?.status).toBe('blocked');
    expect(f.plan()?.steps[0].lastFailure).toMatchObject({ code: 'abandoned', disposition: 'replan' });
    expect(f.runtime.actions).toHaveLength(1);
  });
});

describe('poll-driven lighting maintenance', () => {
  it('schedules one visibility action at night and applies a real success cooldown', async () => {
    const f = fixture();
    f.runtime.snapshot = environment({
      lighting: { blockLight: 0, skyLight: 15 }, body: { inventory: { torch: 2 } },
    });
    f.internal.snapshot = f.runtime.snapshot;

    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(1);
    expect(f.runtime.actions[0]).toMatchObject({
      name: 'ensure_lighting', args: { policy: 'visibility', maxTorches: 4 },
    });
    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(1);

    await f.respond(f.runtime.actions[0]);
    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(1);
  });

  it('lights an underground daytime position but never interprets an unloaded column as dark', async () => {
    const underground = fixture();
    underground.runtime.snapshot = environment({
      world: { timeOfDay: 1_000 }, lighting: { blockLight: 0, skyLight: 0 }, body: { inventory: { torch: 1 } },
    });
    underground.internal.snapshot = underground.runtime.snapshot;
    await underground.internal.poll();
    expect(underground.runtime.actions.map(({ name }) => name)).toEqual(['ensure_lighting']);

    const unknown = fixture();
    unknown.runtime.snapshot = environment({
      lighting: { loaded: false, blockLight: 0, skyLight: 0 }, body: { inventory: { torch: 4 } },
    });
    unknown.internal.snapshot = unknown.runtime.snapshot;
    await unknown.internal.poll();
    expect(unknown.runtime.actions).toHaveLength(0);
  });

  it('does not schedule redundant lighting under a bright daytime sky', async () => {
    const f = fixture();
    f.runtime.snapshot = environment({
      world: { timeOfDay: 1_000 }, lighting: { blockLight: 0, skyLight: 15, canSeeSky: true }, body: { inventory: { torch: 4 } },
    });
    f.internal.snapshot = f.runtime.snapshot;
    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(0);
  });

  it('maintains daytime spawn lighting only after a long stationary foreground task', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(temporaryDirectory());
    f.runtime.snapshot = environment({
      world: { timeOfDay: 1_000 },
      lighting: { blockLight: 0, skyLight: 15, canSeeSky: true },
      body: { inventory: { torch: 4 } },
    });

    await f.internal.poll();
    now += 60_000;
    await f.session.act(planAction('long-build', 'build_resume', {
      blueprintId: 'cabin', origin: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 64, z: 0, name: 'stone', props: {} }], clear: [],
    }, { type: 'blueprint_complete', blueprintId: 'cabin' }));
    await f.internal.poll();
    expect(f.internal.queue).toHaveLength(0);

    now += 20_001;
    await f.internal.poll();
    expect(f.runtime.actions.map(({ name }) => name)).toEqual(['build_structure']);
    expect(f.internal.queue).toHaveLength(1);
    expect(f.internal.queue[0]).toMatchObject({
      bodyAction: 'ensure_lighting', args: { policy: 'spawn-risk' },
    });
  });

  it('surfaces a torch deficit once per cooldown without hidden crafting or placement', async () => {
    const f = fixture();
    f.runtime.snapshot = environment({ lighting: { blockLight: 0, skyLight: 0 } });
    f.internal.snapshot = f.runtime.snapshot;

    await f.internal.poll();
    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(0);
    expect(f.internal.lines.filter((line: string) => line.includes('没有火把'))).toHaveLength(1);
  });

  it('queues maintenance behind the foreground owner and protects active blueprint cells', async () => {
    const f = fixture(temporaryDirectory());
    await f.session.act(planAction('maintenance-build', 'build_resume', {
      blueprintId: 'cabin', origin: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 64, z: 0, name: 'stone', props: {} }],
      clear: [{ x: 0, y: 65, z: 0 }],
    }, { type: 'blueprint_complete', blueprintId: 'cabin' }));
    f.runtime.snapshot = environment({ lighting: { blockLight: 0, skyLight: 0 }, body: { inventory: { torch: 4 } } });
    f.internal.snapshot = f.runtime.snapshot;

    await f.internal.poll();
    await f.internal.poll();
    expect(f.runtime.actions.map(({ name }) => name)).toEqual(['build_structure']);
    expect(f.internal.queue).toHaveLength(1);
    expect(f.internal.queue[0]).toMatchObject({
      bodyAction: 'ensure_lighting',
      args: { protectedCells: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }] },
    });
  });

  it('bounds repeated lighting failures by position and cooldown', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture();
    f.runtime.snapshot = environment({ lighting: { blockLight: 0, skyLight: 0 }, body: { inventory: { torch: 4 } } });
    f.internal.snapshot = f.runtime.snapshot;

    await f.internal.poll();
    await f.respond(f.runtime.actions[0], failure('blocked', { reason: 'no_valid_support' }));
    now += 6_000;
    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(2);
    await f.respond(f.runtime.actions[1], failure('blocked', { reason: 'no_valid_support' }));

    now += 61_000;
    await f.internal.poll();
    expect(f.runtime.actions).toHaveLength(2);
    expect(f.internal.lines.some((line: string) => line.includes('连续两次'))).toBe(true);
  });
});
