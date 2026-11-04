import { describe, expect, it } from 'vitest';
import {
  compareBaseline,
  parseEventsJsonl,
  summarizeRun,
  summarizeRuns,
} from '../../tools/mc-benchmark-lib.mjs';

function action(t: number, actionId: string, phase: 'started' | 'settled', extra: Record<string, unknown> = {}) {
  return { t, type: 'minecraft_action', phase, runId: actionId, actionId, action: 'craft_item', label: 'test', ...extra };
}

function fixture() {
  const raw = {
    suite: 'secure-build', run: 1, startedAt: 1000, endedAt: 1600, ok: false,
    scenarios: [{ name: 'lighting', ok: true, notes: [] }, { name: 'build', ok: false, notes: ['remaining'] }],
  };
  const events = [
    action(1000, 'a1', 'started'),
    action(1100, 'a1', 'settled', { outcome: 'succeeded', certainty: 'certain', inventoryDelta: { oak_log: 1 } }),
    action(1110, 'a2', 'started', { action: 'build_structure', planId: 'p', stepId: 's', role: 'skill' }),
    action(1200, 'a3', 'started', { action: 'build_structure', planId: 'p', stepId: 's', role: 'skill' }),
    action(1400, 'a3', 'settled', {
      action: 'build_structure', planId: 'p', stepId: 's', role: 'skill', outcome: 'succeeded', certainty: 'certain',
      worldChanges: [{ kind: 'block_placed', name: 'stone', count: 2 }],
      buildEvidence: { completed: 8, remaining: 2, remainingClear: 0, unloaded: 0, temporaryBlocks: 1 },
    }),
    action(1410, 'a4', 'started', { planId: 'p', stepId: 's', role: 'recovery' }),
    action(1450, 'a4', 'settled', { planId: 'p', stepId: 's', role: 'recovery', outcome: 'succeeded', certainty: 'certain' }),
    action(1460, 'a5', 'started'),
    action(1500, 'a5', 'settled', { outcome: 'failed', certainty: 'uncertain', errorCode: 'timeout' }),
    { t: 1300, type: 'minecraft_death' },
    { t: 1120, type: 'minecraft_plan', planId: 'p', revision: 1, status: 'active', steps: [
      { id: 's', noProgressAttempts: 1, failureFingerprint: 'same' },
    ] },
    { t: 1130, type: 'minecraft_plan', planId: 'p', revision: 2, status: 'active', steps: [
      { id: 's', noProgressAttempts: 2, failureFingerprint: 'same' },
      { id: 'other', noProgressAttempts: 2, failureFingerprint: 'other' },
    ] },
    // Re-saving the same plan revision must not count the same failure again.
    { t: 1140, type: 'minecraft_plan', planId: 'p', revision: 2, status: 'active', steps: [
      { id: 's', noProgressAttempts: 2, failureFingerprint: 'same' },
      { id: 'other', noProgressAttempts: 2, failureFingerprint: 'other' },
    ] },
    { t: 1500, type: 'minecraft_plan', planId: 'q', revision: 1, status: 'done', steps: [] },
  ];
  return { raw, events };
}

describe('Minecraft structured benchmark metrics', () => {
  it('uses real action, plan, death, and blueprint evidence without parsing prose', () => {
    const { raw, events } = fixture();
    const summary = summarizeRun(raw, events);
    expect(summary.scenarios).toEqual({ passed: 1, failed: 1, total: 2, completionRate: 0.5 });
    expect(summary.plans).toEqual({ done: 1, total: 2, completionRate: 0.5 });
    expect(summary.durationMs).toBe(600);
    expect(summary.deaths).toBe(1);
    expect(summary.actions).toMatchObject({
      started: 5, settled: 4, interrupted: 1, succeeded: 3, failed: 1,
      uncertain: 1, ineffective: 1, withoutReportedWorldEffect: 2,
    });
    expect(summary.idle).toEqual({ observedMs: 120, busyMs: 380 });
    expect(summary.failures.repeatedNoProgress).toBe(2);
    expect(summary.construction).toMatchObject({
      firstEffectiveMs: 400, completed: 8, remaining: 2,
      completionRate: 0.8, verified: 0, total: 1, verifiedRate: 0,
    });
    expect(summary.recovery).toMatchObject({
      plannedInterruptions: 1, recoveredInterruptions: 1, interruptionRate: 1,
      actionsSettled: 1, actionsSucceeded: 1, actionSuccessRate: 1,
    });
    expect(summary.tokenUsage).toEqual({ status: 'unavailable', input: null, output: null, total: null });
  });

  it('does not invent a zero idle time, build rate, recovery rate, or token usage without evidence', () => {
    const summary = summarizeRun({ startedAt: 10, endedAt: 20, ok: true, scenarios: [] }, []);
    expect(summary.idle).toEqual({ observedMs: null, busyMs: null });
    expect(summary.construction.firstEffectiveMs).toBeNull();
    expect(summary.construction.completionRate).toBeNull();
    expect(summary.recovery.interruptionRate).toBeNull();
    expect(summary.tokenUsage.status).toBe('unavailable');
  });

  it('aggregates counts, reports partial token coverage, and compares a baseline', () => {
    const first = summarizeRun(fixture().raw, fixture().events);
    const second = summarizeRun({
      startedAt: 2000, endedAt: 2300, ok: true,
      scenarios: [{ name: 'lighting', ok: true }],
      tokenUsage: { input: 100, output: 25 },
    }, []);
    const current = summarizeRuns([first, second]);
    expect(current.runCount).toBe(2);
    expect(current.scenarios.completionRate).toBe(2 / 3);
    expect(current.deaths).toBe(1);
    expect(current.durationMs).toBe(450);
    expect(current.idle.observedMs).toBe(120);
    expect(current.idle.runsWithData).toBe(1);
    expect(current.tokenUsage).toEqual({ status: 'partial', measuredRuns: 1, input: 100, output: 25, total: 125 });

    const baseline = summarizeRuns([{ ...first, deaths: 3 }]);
    const comparison = compareBaseline(current, baseline);
    expect(comparison.deaths).toEqual({ baseline: 3, current: 1, delta: -2 });
    expect(comparison.durationMs).toEqual({ baseline: 600, current: 450, delta: -150 });
    expect(comparison.totalTokens.status).toBe('unavailable');
  });

  it('fails loudly on malformed JSONL and missing Minecraft timestamps', () => {
    expect(parseEventsJsonl('{"t":1,"type":"minecraft_death"}\n')).toHaveLength(1);
    expect(() => parseEventsJsonl('{bad json}\n', 'run.jsonl')).toThrow('run.jsonl:1: invalid JSON');
    expect(() => parseEventsJsonl('{"type":"minecraft_death"}\n')).toThrow('finite timestamp');
  });
});
