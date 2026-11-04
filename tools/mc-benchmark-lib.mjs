/** Pure, offline metrics for Minecraft run events. No model text is parsed as evidence. */

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const count = (value) => finite(value) && value >= 0 ? value : 0;
const ratio = (part, total) => total > 0 ? part / total : null;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => values.length ? sum(values) / values.length : null;

function tokens(raw) {
  const usage = raw?.tokenUsage;
  if (!usage || !finite(usage.input) || !finite(usage.output)
    || usage.input < 0 || usage.output < 0) {
    return { status: 'unavailable', input: null, output: null, total: null };
  }
  return { status: 'measured', input: usage.input, output: usage.output, total: usage.input + usage.output };
}

function realChange(event) {
  if (Object.values(event.inventoryDelta ?? {}).some((value) => finite(value) && value !== 0)) return true;
  if ((event.worldChanges ?? []).some((change) => count(change?.count) > 0)) return true;
  const build = event.buildEvidence;
  return !!build && (count(build.completed) > 0 || count(build.remaining) > 0
    || count(build.remainingClear) > 0 || count(build.unloaded) > 0 || count(build.temporaryBlocks) > 0);
}

/** Merge settled action intervals; unfinished stale actions do not masquerade as settled work. */
function idleMetrics(started, settledByAction) {
  const intervals = [];
  for (const action of started.values()) {
    const settled = settledByAction.get(action.actionId);
    if (settled && finite(action.t) && finite(settled.t) && settled.t >= action.t) {
      intervals.push([action.t, settled.t]);
    }
  }
  if (!intervals.length) return { observedMs: null, busyMs: null };
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const busyMs = sum(merged.map(([start, end]) => end - start));
  const observedMs = Math.max(0, merged.at(-1)[1] - merged[0][0] - busyMs);
  return { observedMs, busyMs };
}

export function summarizeRun(raw, events) {
  if (!raw || typeof raw !== 'object') throw new Error('A benchmark run result must be a JSON object.');
  if (!Array.isArray(events)) throw new Error('Benchmark events must be an array.');

  const started = new Map();
  const settledByAction = new Map();
  const settled = [];
  const plans = new Map();
  const progress = new Map();
  const builds = new Map();
  let repeatedNoProgressFailures = 0;
  let deaths = 0;
  let firstEffectiveBuildMs = null;

  const startedAt = finite(raw.startedAt) ? raw.startedAt : events.find((event) => finite(event?.t))?.t;
  const endedAt = finite(raw.endedAt) ? raw.endedAt : events.filter((event) => finite(event?.t)).at(-1)?.t;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'minecraft_death') {
      deaths += 1;
      continue;
    }
    if (event.type === 'minecraft_plan') {
      if (typeof event.planId !== 'string' || !Array.isArray(event.steps)) continue;
      plans.set(event.planId, event);
      for (const step of event.steps) {
        if (!step || typeof step.id !== 'string') continue;
        const key = `${event.planId}/${step.id}`;
        const current = count(step.noProgressAttempts);
        const fingerprint = typeof step.failureFingerprint === 'string' ? step.failureFingerprint : '';
        const previous = progress.get(key);
        if (current === 0) {
          progress.set(key, { count: 0, fingerprint: '' });
        } else if (!previous || previous.count === 0 || previous.fingerprint !== fingerprint) {
          repeatedNoProgressFailures += Math.max(0, current - 1);
          progress.set(key, { count: current, fingerprint });
        } else if (current > previous.count) {
          repeatedNoProgressFailures += current - Math.max(1, previous.count);
          progress.set(key, { count: current, fingerprint });
        }
      }
      continue;
    }
    if (event.type !== 'minecraft_action') continue;
    if (event.phase === 'started' && typeof event.actionId === 'string') {
      if (!started.has(event.actionId)) started.set(event.actionId, event);
      continue;
    }
    if (event.phase !== 'settled' || typeof event.actionId !== 'string') continue;
    settled.push(event);
    if (!settledByAction.has(event.actionId)) settledByAction.set(event.actionId, event);

    if ((event.action === 'build_structure' || event.action === 'creative_build')
      && (event.worldChanges ?? []).some((change) => change?.kind === 'block_placed' && count(change.count) > 0)
      && firstEffectiveBuildMs === null && finite(startedAt) && finite(event.t)) {
      firstEffectiveBuildMs = Math.max(0, event.t - startedAt);
    }
    if (event.buildEvidence) {
      const evidence = event.buildEvidence;
      const key = `${event.planId ?? 'unplanned'}/${event.stepId ?? event.actionId}`;
      builds.set(key, {
        completed: count(evidence.completed),
        remaining: count(evidence.remaining),
        remainingClear: count(evidence.remainingClear),
        unloaded: count(evidence.unloaded),
      });
    }
  }

  const scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  const scenariosPassed = scenarios.filter((scenario) => scenario?.ok === true).length;
  const planList = [...plans.values()];
  const plansDone = planList.filter((plan) => plan.status === 'done').length;
  const interrupted = [...started.values()].filter((event) => !settledByAction.has(event.actionId));
  const plannedInterruptions = interrupted.filter((event) => event.planId && event.stepId);
  const recoveredInterruptions = plannedInterruptions.filter((interruption) => settled.some((event) =>
    event.planId === interruption.planId && event.stepId === interruption.stepId
    && event.role !== 'recovery' && event.outcome === 'succeeded'
    && finite(event.t) && finite(interruption.t) && event.t > interruption.t));
  const recoveryActions = settled.filter((event) => event.role === 'recovery');
  const recoveryActionsSucceeded = recoveryActions.filter((event) => event.outcome === 'succeeded').length;
  const buildList = [...builds.values()];
  const buildCompleted = sum(buildList.map((build) => build.completed));
  const buildRemaining = sum(buildList.map((build) => build.remaining));
  const buildRemainingClear = sum(buildList.map((build) => build.remainingClear));
  const buildUnloaded = sum(buildList.map((build) => build.unloaded));
  const buildsVerified = buildList.filter((build) =>
    build.remaining === 0 && build.remainingClear === 0 && build.unloaded === 0).length;
  const idle = idleMetrics(started, settledByAction);

  return {
    suite: typeof raw.suite === 'string' ? raw.suite : null,
    run: raw.run ?? null,
    seed: raw.seed ?? null,
    ok: raw.ok === true && scenarios.every((scenario) => scenario?.ok === true),
    scenarios: {
      passed: scenariosPassed,
      failed: scenarios.length - scenariosPassed,
      total: scenarios.length,
      completionRate: ratio(scenariosPassed, scenarios.length),
    },
    plans: { done: plansDone, total: planList.length, completionRate: ratio(plansDone, planList.length) },
    durationMs: finite(startedAt) && finite(endedAt) ? Math.max(0, endedAt - startedAt) : null,
    deaths,
    actions: {
      started: started.size,
      settled: settled.length,
      interrupted: interrupted.length,
      succeeded: settled.filter((event) => event.outcome === 'succeeded').length,
      failed: settled.filter((event) => event.outcome === 'failed').length,
      cancelled: settled.filter((event) => event.outcome === 'cancelled').length,
      uncertain: settled.filter((event) => event.certainty === 'uncertain').length,
      // Conservative: movement and other real effects not represented in RunEvent are not guessed.
      ineffective: settled.filter((event) => event.outcome === 'failed' || event.outcome === 'cancelled'
        || event.errorCode === 'postcondition_unmet').length,
      withoutReportedWorldEffect: settled.filter((event) => !realChange(event)).length,
    },
    idle,
    failures: { repeatedNoProgress: repeatedNoProgressFailures },
    construction: {
      firstEffectiveMs: firstEffectiveBuildMs,
      completed: buildCompleted,
      remaining: buildRemaining,
      remainingClear: buildRemainingClear,
      unloaded: buildUnloaded,
      completionRate: ratio(buildCompleted, buildCompleted + buildRemaining),
      verified: buildsVerified,
      total: buildList.length,
      verifiedRate: ratio(buildsVerified, buildList.length),
    },
    recovery: {
      plannedInterruptions: plannedInterruptions.length,
      recoveredInterruptions: recoveredInterruptions.length,
      interruptionRate: ratio(recoveredInterruptions.length, plannedInterruptions.length),
      actionsSettled: recoveryActions.length,
      actionsSucceeded: recoveryActionsSucceeded,
      actionSuccessRate: ratio(recoveryActionsSucceeded, recoveryActions.length),
    },
    tokenUsage: tokens(raw),
  };
}

export function summarizeRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) throw new Error('At least one run summary is required.');
  const total = (select) => sum(runs.map((run) => count(select(run))));
  const average = (select) => mean(runs.map(select).filter(finite));
  const scenariosPassed = total((run) => run.scenarios.passed);
  const scenariosTotal = total((run) => run.scenarios.total);
  const plansDone = total((run) => run.plans.done);
  const plansTotal = total((run) => run.plans.total);
  const completed = total((run) => run.construction.completed);
  const remaining = total((run) => run.construction.remaining);
  const verified = total((run) => run.construction.verified);
  const buildTotal = total((run) => run.construction.total);
  const interruptions = total((run) => run.recovery.plannedInterruptions);
  const recovered = total((run) => run.recovery.recoveredInterruptions);
  const recoverySettled = total((run) => run.recovery.actionsSettled);
  const recoverySucceeded = total((run) => run.recovery.actionsSucceeded);
  const measuredTokens = runs.filter((run) => run.tokenUsage.status === 'measured');
  const tokenStatus = measuredTokens.length === 0 ? 'unavailable'
    : measuredTokens.length === runs.length ? 'measured' : 'partial';

  return {
    runCount: runs.length,
    successfulRuns: runs.filter((run) => run.ok).length,
    scenarios: {
      passed: scenariosPassed,
      failed: scenariosTotal - scenariosPassed,
      total: scenariosTotal,
      completionRate: ratio(scenariosPassed, scenariosTotal),
    },
    plans: { done: plansDone, total: plansTotal, completionRate: ratio(plansDone, plansTotal) },
    durationMs: average((run) => run.durationMs),
    deaths: total((run) => run.deaths),
    actions: {
      started: total((run) => run.actions.started),
      settled: total((run) => run.actions.settled),
      interrupted: total((run) => run.actions.interrupted),
      succeeded: total((run) => run.actions.succeeded),
      failed: total((run) => run.actions.failed),
      cancelled: total((run) => run.actions.cancelled),
      uncertain: total((run) => run.actions.uncertain),
      ineffective: total((run) => run.actions.ineffective),
      withoutReportedWorldEffect: total((run) => run.actions.withoutReportedWorldEffect),
    },
    idle: {
      observedMs: average((run) => run.idle.observedMs),
      busyMs: average((run) => run.idle.busyMs),
      runsWithData: runs.filter((run) => finite(run.idle.observedMs)).length,
    },
    failures: { repeatedNoProgress: total((run) => run.failures.repeatedNoProgress) },
    construction: {
      firstEffectiveMs: average((run) => run.construction.firstEffectiveMs),
      completed,
      remaining,
      remainingClear: total((run) => run.construction.remainingClear),
      unloaded: total((run) => run.construction.unloaded),
      completionRate: ratio(completed, completed + remaining),
      verified,
      total: buildTotal,
      verifiedRate: ratio(verified, buildTotal),
    },
    recovery: {
      plannedInterruptions: interruptions,
      recoveredInterruptions: recovered,
      interruptionRate: ratio(recovered, interruptions),
      actionsSettled: recoverySettled,
      actionsSucceeded: recoverySucceeded,
      actionSuccessRate: ratio(recoverySucceeded, recoverySettled),
    },
    tokenUsage: {
      status: tokenStatus,
      measuredRuns: measuredTokens.length,
      input: tokenStatus === 'unavailable' ? null : sum(measuredTokens.map((run) => run.tokenUsage.input)),
      output: tokenStatus === 'unavailable' ? null : sum(measuredTokens.map((run) => run.tokenUsage.output)),
      total: tokenStatus === 'unavailable' ? null : sum(measuredTokens.map((run) => run.tokenUsage.total)),
    },
  };
}

const COMPARISONS = [
  ['scenarioCompletionRate', (summary) => summary.scenarios.completionRate],
  ['durationMs', (summary) => summary.durationMs],
  ['deaths', (summary) => summary.deaths],
  ['observedIdleMs', (summary) => summary.idle.observedMs],
  ['ineffectiveActions', (summary) => summary.actions.ineffective],
  ['repeatedNoProgressFailures', (summary) => summary.failures.repeatedNoProgress],
  ['firstEffectiveBuildMs', (summary) => summary.construction.firstEffectiveMs],
  ['buildCompletionRate', (summary) => summary.construction.completionRate],
  ['buildVerifiedRate', (summary) => summary.construction.verifiedRate],
  ['interruptionRecoveryRate', (summary) => summary.recovery.interruptionRate],
  ['totalTokens', (summary) => summary.tokenUsage.status === 'measured' ? summary.tokenUsage.total : null],
];

export function compareBaseline(current, baseline) {
  return Object.fromEntries(COMPARISONS.map(([name, select]) => {
    const before = select(baseline);
    const after = select(current);
    return [name, finite(before) && finite(after)
      ? { baseline: before, current: after, delta: after - before }
      : { baseline: before ?? null, current: after ?? null, delta: null, status: 'unavailable' }];
  }));
}

export function parseEventsJsonl(text, file = 'events.jsonl') {
  const events = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`);
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`${file}:${index + 1}: expected an event object.`);
    }
    if (event.type?.startsWith?.('minecraft_') && !finite(event.t)) {
      throw new Error(`${file}:${index + 1}: Minecraft events require a finite timestamp t.`);
    }
    events.push(event);
  }
  return events;
}
