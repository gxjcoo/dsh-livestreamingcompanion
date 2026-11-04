import { describe, expect, it } from 'vitest';
import {
  FAILURE_DISPOSITIONS,
  PLAN_VERSION,
  PlanValidationError,
  beginStep,
  canonicalFingerprint,
  canonicalizeArgs,
  completeStep,
  createPlan,
  evaluateCompletion,
  failRecovery,
  failStep,
  markRecoveryStarted,
  resetRecoveryStarted,
  migratePlan,
  parsePlan,
  retryBackoffMs,
  validatePlan,
  wrapLegacyGoal,
  type CompletionPredicate,
  type FailureDisposition,
  type MinecraftPlan,
  type PlanStepDraft,
  type WorldPosition,
} from '../src/games/minecraft/plan.js';

const position: WorldPosition = { x: 10, y: 64, z: -5, dimension: 'overworld' };
const haveLogs: CompletionPredicate = { type: 'inventory_at_least', item: 'oak_log', count: 4 };
const nearHome: CompletionPredicate = { type: 'near_position', position, radius: 3 };
const litHome: CompletionPredicate = { type: 'block_light_at_least', position, minimum: 8 };

function draft(overrides: Partial<PlanStepDraft> = {}): PlanStepDraft {
  return {
    skill: 'gather_wood',
    args: { item: 'oak_log', count: 4 },
    completion: haveLogs,
    ...overrides,
  };
}

function planWith(steps: PlanStepDraft[], id = 'plan-test'): MinecraftPlan {
  return createPlan('build a safe cabin', steps, { id, now: 100 });
}

function started(step: PlanStepDraft = draft(), id = 'plan-test'): MinecraftPlan {
  return beginStep(planWith([step], id), 'step-1', { now: 101, progress: { logs: 0 } });
}

describe('plan creation, migration and validation', () => {
  it('wraps legacy text and journal goals without inventing completion', () => {
    const fromText = migratePlan('survive the night', { id: 'legacy-text', now: 42 });
    const fromJournal = migratePlan({ goal: 'build a home', sessions: 7, deaths: [] }, { id: 'legacy-journal', now: 50 });
    const direct = wrapLegacyGoal('keep farming', { id: 'legacy-direct', now: 60 });

    for (const [id, plan] of Object.entries({ 'legacy-text': fromText, 'legacy-journal': fromJournal, 'legacy-direct': direct })) {
      expect(plan).toMatchObject({
        version: PLAN_VERSION,
        id,
        revision: 1,
        status: 'active',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        steps: [],
      });
      expect(validatePlan(plan).ok).toBe(true);
    }
    expect(fromText.goal).toBe('survive the night');
    expect(fromJournal.goal).toBe('build a home');
    expect(fromText.status).not.toBe('done');
  });

  it('migrates structured drafts with stable ordered ids and dependencies', () => {
    const plan = migratePlan({
      goal: '  settle here  ',
      steps: [draft(), draft({ skill: 'go_to', args: { position }, completion: nearHome })],
    }, { id: 'draft-plan', now: 10 });

    expect(plan.goal).toBe('settle here');
    expect(plan.steps.map((step) => step.id)).toEqual(['step-1', 'step-2']);
    expect(plan.steps.map((step) => step.dependsOn)).toEqual([[], ['step-1']]);
    expect(plan.steps.every((step) => step.status === 'pending' && step.attempts === 0)).toBe(true);
  });

  it('round-trips JSON and canonicalizes object keys without changing arrays', () => {
    const plan = planWith([draft({
      args: { z: 1, a: { z: 2, a: 3 }, list: [{ b: 2, a: 1 }, 3] },
    })]);
    expect(Object.keys(plan.steps[0].args)).toEqual(['a', 'list', 'z']);
    expect(Object.keys(plan.steps[0].args.a as object)).toEqual(['a', 'z']);
    expect(plan.steps[0].args.list).toEqual([{ a: 1, b: 2 }, 3]);

    const restored = parsePlan(JSON.parse(JSON.stringify(plan)));
    expect(restored).toEqual(plan);
    expect(canonicalizeArgs({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
  });

  it('rejects malformed persisted plans and duplicate or forward dependencies', () => {
    const valid = planWith([draft(), draft({ id: 'second', skill: 'go_to', completion: nearHome })]);
    const duplicate = structuredClone(valid);
    duplicate.steps[1].id = 'step-1';
    const forward = structuredClone(valid);
    forward.steps[0].dependsOn = ['second'];
    const badStatus = structuredClone(valid);
    badStatus.status = 'done';

    expect(validatePlan(duplicate)).toMatchObject({ ok: false });
    expect(validatePlan(forward)).toMatchObject({ ok: false });
    expect(validatePlan(badStatus)).toMatchObject({ ok: false });
    expect(() => parsePlan({ ...valid, version: 999 })).toThrow(PlanValidationError);
  });

  it('rejects untrusted non-JSON values, prototype keys and model-only predicates', () => {
    expect(() => planWith([draft({ args: { count: Number.NaN } })])).toThrow(PlanValidationError);
    expect(() => planWith([draft({ args: { callback: (() => true) as never } })])).toThrow(PlanValidationError);
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, never>;
    expect(() => canonicalizeArgs(polluted)).toThrow(PlanValidationError);
    expect(() => planWith([draft({ completion: { type: 'model_says_done' } as never })])).toThrow(PlanValidationError);
    expect(() => planWith([draft({ completion: { type: 'all_of', predicates: [] } })])).toThrow(PlanValidationError);
  });

  it('validates retry invariants restored from a journal', () => {
    const plan = started();
    const failed = failStep(plan, 'step-1', {
      now: 102,
      code: 'blocked',
      disposition: 'retry',
      progress: { logs: 0 },
    });
    expect(validatePlan(failed).ok).toBe(true);
    const missingRetryTime = structuredClone(failed);
    delete missingRetryTime.steps[0].nextRetryAt;
    expect(validatePlan(missingRetryTime)).toMatchObject({ ok: false });
  });
});

describe('typed tri-state completion evidence', () => {
  it('evaluates inventory as unknown, unmet, or met', () => {
    expect(evaluateCompletion(haveLogs, {})).toBe('unknown');
    expect(evaluateCompletion(haveLogs, { inventory: {} })).toBe('unmet');
    expect(evaluateCompletion(haveLogs, { inventory: { oak_log: 3 } })).toBe('unmet');
    expect(evaluateCompletion(haveLogs, { inventory: { oak_log: 4 } })).toBe('met');
    expect(evaluateCompletion(haveLogs, { inventory: { oak_log: 8 } })).toBe('met');
  });

  it('treats unloaded light as unknown even when a numeric value is supplied', () => {
    expect(evaluateCompletion(litHome, {})).toBe('unknown');
    expect(evaluateCompletion(litHome, {
      blockLight: [{ ...position, loaded: false, blockLight: 0 }],
    })).toBe('unknown');
    expect(evaluateCompletion(litHome, {
      blockLight: [{ ...position, loaded: false, blockLight: 15 }],
    })).toBe('unknown');
    expect(evaluateCompletion(litHome, {
      blockLight: [{ ...position, loaded: true, blockLight: 7 }],
    })).toBe('unmet');
    expect(evaluateCompletion(litHome, {
      blockLight: [{ ...position, loaded: true, blockLight: 8 }],
    })).toBe('met');
  });

  it('evaluates position with dimension and radius checks', () => {
    expect(evaluateCompletion(nearHome, {})).toBe('unknown');
    expect(evaluateCompletion(nearHome, { position: { ...position, dimension: 'the_nether' } })).toBe('unmet');
    expect(evaluateCompletion(nearHome, { position: { ...position, x: position.x + 4 } })).toBe('unmet');
    expect(evaluateCompletion(nearHome, { position: { ...position, x: position.x + 3 } })).toBe('met');
  });

  it('uses real blueprint diffs and preserves unknown unloaded cells', () => {
    const predicate: CompletionPredicate = { type: 'blueprint_complete', blueprintId: 'cabin-v1' };
    expect(evaluateCompletion(predicate, {})).toBe('unknown');
    expect(evaluateCompletion(predicate, { blueprints: { 'cabin-v1': { remaining: 2, unloaded: 4 } } })).toBe('unmet');
    expect(evaluateCompletion(predicate, { blueprints: { 'cabin-v1': { remaining: 0, unloaded: 4 } } })).toBe('unknown');
    expect(evaluateCompletion(predicate, { blueprints: { 'cabin-v1': { remaining: 0, unloaded: 0 } } })).toBe('met');
  });

  it('composes all-of with unmet taking precedence over unknown', () => {
    const predicate: CompletionPredicate = { type: 'all_of', predicates: [haveLogs, litHome] };
    expect(evaluateCompletion(predicate, { inventory: { oak_log: 4 } })).toBe('unknown');
    expect(evaluateCompletion(predicate, {
      inventory: { oak_log: 4 },
      blockLight: [{ ...position, loaded: true, blockLight: 9 }],
    })).toBe('met');
    expect(evaluateCompletion(predicate, {
      inventory: { oak_log: 0 },
      blockLight: [{ ...position, loaded: false }],
    })).toBe('unmet');
  });

  it('never lets a result summary or other model text complete a running step', () => {
    const running = started();
    expect(() => completeStep(running, 'step-1', { summary: '已完成，背包里有四根木头' } as never, { now: 102 }))
      .toThrow('completion is unknown');
    expect(() => completeStep(running, 'step-1', { inventory: { oak_log: 1 } }, { now: 102 }))
      .toThrow('completion is unmet');
    expect(running.steps[0].status).toBe('running');
    expect(running.revision).toBe(2);

    const done = completeStep(running, 'step-1', { inventory: { oak_log: 4 } }, { now: 102 });
    expect(done.status).toBe('done');
    expect(done.steps[0].status).toBe('done');
    expect(done.revision).toBe(3);
  });
});

describe('ordered immutable transitions', () => {
  it('does not begin a later step before earlier completion', () => {
    const original = planWith([
      draft(),
      draft({ skill: 'go_to', args: { position }, completion: nearHome }),
    ]);
    expect(() => beginStep(original, 'step-2', { now: 101 })).toThrow('incomplete earlier step');

    const running = beginStep(original, 'step-1', { now: 101 });
    expect(original.steps[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(original.revision).toBe(1);
    expect(running.steps[0]).toMatchObject({ status: 'running', attempts: 1 });
    expect(() => beginStep(running, 'step-2', { now: 102 })).toThrow('incomplete earlier step');

    const firstDone = completeStep(running, 'step-1', { inventory: { oak_log: 4 } }, { now: 102 });
    const secondRunning = beginStep(firstDone, 'step-2', { now: 103 });
    expect(secondRunning.steps.map((step) => step.status)).toEqual(['done', 'running']);
    expect(secondRunning.status).toBe('active');
  });

  it('rejects duplicate begins and backwards timestamps without mutating input', () => {
    const running = started();
    const before = structuredClone(running);
    expect(() => beginStep(running, 'step-1', { now: 102 })).toThrow('cannot begin a running step');
    expect(() => completeStep(running, 'step-1', { inventory: { oak_log: 4 } }, { now: 100 }))
      .toThrow('timestamp backwards');
    expect(running).toEqual(before);
  });
});

describe('failure dispositions, retry budgets and deterministic backoff', () => {
  it('uses capped exponential backoff with no random jitter', () => {
    const options = { baseMs: 250, maxMs: 1_000 };
    expect([1, 2, 3, 4, 5, 20].map((attempt) => retryBackoffMs(attempt, options)))
      .toEqual([250, 500, 1_000, 1_000, 1_000, 1_000]);
    expect(retryBackoffMs(1, options)).toBe(retryBackoffMs(1, options));

    const failed = failStep(started(), 'step-1', {
      now: 102,
      code: 'timeout',
      disposition: 'retry',
      backoff: options,
      progress: { logs: 0 },
    });
    expect(failed.steps[0].nextRetryAt).toBe(352);
  });

  it('enforces cooldown and the total attempt budget', () => {
    const running = started(draft({ maxAttempts: 2, maxNoProgressAttempts: 2 }));
    const first = failStep(running, 'step-1', {
      now: 102,
      code: 'blocked',
      disposition: 'retry',
      progress: { logs: 0 },
      backoff: { baseMs: 10, maxMs: 100 },
    });
    expect(first.steps[0]).toMatchObject({
      status: 'blocked', attempts: 1, noProgressAttempts: 1, nextRetryAt: 112,
      lastFailure: { disposition: 'retry' },
    });
    expect(first.status).toBe('active');
    expect(() => beginStep(first, 'step-1', { now: 111 })).toThrow('cooling down');

    const second = beginStep(first, 'step-1', { now: 112, progress: { logs: 0 } });
    expect(second.steps[0].attempts).toBe(2);
    const exhausted = failStep(second, 'step-1', {
      now: 113,
      code: 'blocked',
      disposition: 'retry',
      progress: { logs: 0 },
      backoff: { baseMs: 10, maxMs: 100 },
    });
    expect(exhausted.status).toBe('blocked');
    expect(exhausted.steps[0]).toMatchObject({
      status: 'blocked', attempts: 2,
      lastFailure: { disposition: 'needs_decision' },
    });
    expect(exhausted.steps[0].nextRetryAt).toBeUndefined();
    expect(() => beginStep(exhausted, 'step-1', { now: 1_000 })).toThrow('blocked plan');
    expect(validatePlan(exhausted).ok).toBe(true);
  });

  it('stops same-failure retries after the bounded no-progress budget', () => {
    const running = started(draft({ maxAttempts: 5, maxNoProgressAttempts: 2 }));
    const first = failStep(running, 'step-1', {
      now: 102,
      code: 'path_unreachable',
      disposition: 'retry',
      action: 'gather',
      target: { b: 2, a: 1 },
      context: { dimension: 'overworld' },
      progress: { logs: 0 },
      backoff: { baseMs: 10, maxMs: 100 },
    });
    const second = beginStep(first, 'step-1', { now: 112, progress: { logs: 0 } });
    const stalled = failStep(second, 'step-1', {
      now: 113,
      code: 'path_unreachable',
      disposition: 'retry',
      action: 'gather',
      // Different key order is the same canonical attempt and same lack of progress.
      target: { a: 1, b: 2 },
      context: { dimension: 'overworld' },
      progress: { logs: 0 },
    });
    expect(stalled.steps[0].noProgressAttempts).toBe(2);
    expect(stalled.steps[0].lastFailure?.disposition).toBe('replan');
    expect(stalled.steps[0].nextRetryAt).toBeUndefined();
    expect(stalled.status).toBe('blocked');
  });

  it('resets the no-progress streak when real evidence changes', () => {
    const running = started(draft({ maxAttempts: 5, maxNoProgressAttempts: 2 }));
    const first = failStep(running, 'step-1', {
      now: 102, code: 'partial', disposition: 'retry', progress: { logs: 0 },
      backoff: { baseMs: 10, maxMs: 100 },
    });
    const second = beginStep(first, 'step-1', { now: 112 });
    const progressed = failStep(second, 'step-1', {
      now: 113, code: 'partial', disposition: 'retry', progress: { logs: 2 },
      backoff: { baseMs: 10, maxMs: 100 },
    });
    expect(progressed.steps[0].noProgressAttempts).toBe(0);
    expect(progressed.steps[0].progressSignature).toBe('{"logs":2}');
    expect(progressed.steps[0].lastFailure?.disposition).toBe('retry');
    expect(progressed.steps[0].nextRetryAt).toBe(133);
  });

  it('forces uncertain non-idempotent results to needs_decision', () => {
    const failed = failStep(started(draft({ skill: 'craft_item' })), 'step-1', {
      now: 102,
      code: 'timeout_after_craft',
      disposition: 'retry',
      certainty: 'uncertain',
      idempotent: false,
      progress: { logs: 0 },
    });
    expect(failed.status).toBe('blocked');
    expect(failed.steps[0].lastFailure).toMatchObject({
      disposition: 'needs_decision', certainty: 'uncertain', idempotent: false,
    });
    expect(failed.steps[0].nextRetryAt).toBeUndefined();
  });

  it('allows an uncertain idempotent operation to retry after reconciliation delay', () => {
    const failed = failStep(started(draft({ skill: 'go_to' })), 'step-1', {
      now: 102,
      code: 'timeout',
      disposition: 'retry',
      certainty: 'uncertain',
      idempotent: true,
      backoff: { baseMs: 20, maxMs: 100 },
    });
    expect(failed.status).toBe('active');
    expect(failed.steps[0].lastFailure?.disposition).toBe('retry');
    expect(failed.steps[0].nextRetryAt).toBe(122);
  });

  it.each(FAILURE_DISPOSITIONS)('records the %s disposition explicitly', (disposition: FailureDisposition) => {
    const failed = failStep(started(), 'step-1', {
      now: 102,
      code: 'classified_failure',
      disposition,
    });
    expect(failed.steps[0].status).toBe('blocked');
    expect(failed.steps[0].lastFailure?.disposition).toBe(disposition);
    expect(failed.status).toBe(disposition === 'replan' || disposition === 'needs_decision' ? 'blocked' : 'active');
    expect(failed.steps[0].nextRetryAt !== undefined).toBe(disposition === 'retry');
    expect(validatePlan(failed).ok).toBe(true);
  });
});

describe('persisted recovery barriers', () => {
  const recovery = {
    disposition: 'supply' as const,
    bodyAction: 'collect_item',
    args: { item: 'oak_log', quantity: 4 },
    label: 'Collect four logs',
    idempotent: true,
  };

  it('requires real recovery proof and clears the persisted action only when resumed', () => {
    const blocked = failStep(started(), 'step-1', {
      now: 102, code: 'missing_item', disposition: 'supply', idempotent: true,
      recovery, recoveryAttempts: 1, progress: { logs: 0 },
    });
    expect(blocked.steps[0].pendingRecovery).toMatchObject({ started: false, bodyAction: 'collect_item' });
    expect(blocked.steps[0].recoveryAttempts).toBe(1);
    expect(() => beginStep(blocked, 'step-1', { now: 103 })).toThrow('requires a completed supply recovery');

    const resumed = beginStep(blocked, 'step-1', { now: 103, recovered: true, progress: { logs: 4 } });
    expect(resumed.steps[0].status).toBe('running');
    expect(resumed.steps[0].attempts).toBe(2);
    expect(resumed.steps[0].pendingRecovery).toBeUndefined();
    expect(resumed.steps[0].recoveryAttempts).toBe(1);
  });

  it('persists the dispatch barrier and safely re-arms only idempotent recovery', () => {
    const blocked = failStep(started(), 'step-1', {
      now: 102, code: 'missing_item', disposition: 'supply', recovery,
    });
    const startedRecovery = markRecoveryStarted(blocked, 'step-1', { now: 103 });
    expect(parsePlan(JSON.parse(JSON.stringify(startedRecovery))).steps[0].pendingRecovery?.started).toBe(true);
    const rearmed = resetRecoveryStarted(startedRecovery, 'step-1', { now: 104 });
    expect(rearmed.steps[0].pendingRecovery?.started).toBe(false);

    const nonIdempotent = failStep(started(draft({ skill: 'ensure_food' }), 'other'), 'step-1', {
      now: 102, code: 'missing_item', disposition: 'supply',
      recovery: { ...recovery, bodyAction: 'craft_item', idempotent: false },
    });
    const dispatched = markRecoveryStarted(nonIdempotent, 'step-1', { now: 103 });
    expect(() => resetRecoveryStarted(dispatched, 'step-1', { now: 104 })).toThrow('cannot be re-armed');
    const failed = failRecovery(dispatched, 'step-1', {
      now: 104, code: 'interrupted', certainty: 'uncertain', disposition: 'needs_decision',
    });
    expect(failed.status).toBe('blocked');
    expect(failed.steps[0].pendingRecovery).toBeUndefined();
    expect(failed.steps[0].lastFailure).toMatchObject({ disposition: 'needs_decision', certainty: 'uncertain' });
  });

  it('does not treat a failed defence as proof that the site is safe', () => {
    const blocked = failStep(started(), 'step-1', {
      now: 102, code: 'unsafe', disposition: 'defence', idempotent: true,
      recovery: { ...recovery, disposition: 'defence', bodyAction: 'attack_entity', idempotent: false },
    });
    const failed = failRecovery(markRecoveryStarted(blocked, 'step-1', { now: 103 }), 'step-1', {
      now: 104, code: 'timeout', certainty: 'uncertain', disposition: 'retry',
    });
    expect(failed.status).toBe('blocked');
    expect(failed.steps[0].lastFailure?.disposition).toBe('needs_decision');
    expect(() => beginStep(failed, 'step-1', { now: 105, recovered: true })).toThrow('blocked plan');
  });
});

describe('canonical attempt fingerprints', () => {
  const base = {
    planId: 'plan-a',
    stepId: 'step-1',
    action: 'place_block',
    target: { position: { x: 1, y: 2, z: 3 }, block: 'torch' },
    context: { dimension: 'overworld', tags: ['build', 'light'] },
  };

  it('is independent of object key order and sensitive to meaningful changes', () => {
    const reordered = {
      context: { tags: ['build', 'light'], dimension: 'overworld' },
      target: { block: 'torch', position: { z: 3, y: 2, x: 1 } },
      action: 'place_block',
      stepId: 'step-1',
      planId: 'plan-a',
    };
    expect(canonicalFingerprint(reordered)).toBe(canonicalFingerprint(base));
    expect(canonicalFingerprint({ ...base, action: 'dig_at' })).not.toBe(canonicalFingerprint(base));
    expect(canonicalFingerprint({ ...base, stepId: 'step-2' })).not.toBe(canonicalFingerprint(base));
    expect(canonicalFingerprint({ ...base, target: { ...base.target, block: 'lantern' } }))
      .not.toBe(canonicalFingerprint(base));
  });

  it('keeps array order significant in canonical context', () => {
    expect(canonicalFingerprint({ ...base, context: { ...base.context, tags: ['light', 'build'] } }))
      .not.toBe(canonicalFingerprint(base));
  });
});
