#!/usr/bin/env node
/**
 * Repeat the isolated scripted Minecraft self-test and summarize real RunEvents.
 * This never downloads/starts a server and does not claim to run a real agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compareBaseline,
  parseEventsJsonl,
  summarizeRun,
  summarizeRuns,
} from './mc-benchmark-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITES = ['all', 'basic', 'edge', 'breath', 'build', 'lighting', 'secure-build', 'resume', 'failure-loop', 'farm', 'journal', 'nether', 'creative', 'rcon', 'live'];
const HELP = `Usage:
  node tools/mc-benchmark.mjs --suite all --runs 3 [--baseline old-summary.json]
  node tools/mc-benchmark.mjs --summarize RUN_DIR [RUN_DIR ...] [--baseline old-summary.json]

Options:
  --suite NAME       Scripted self-test suite (default: all).
  --runs N           Number of isolated self-test repetitions (default: 1).
  --out-dir DIR      Output directory; default is an ignored .mc-benchmark subdirectory.
  --summarize DIRS   Offline only: summarize run directories containing result.json/events.jsonl.
  --baseline FILE    Compare numeric metrics with a previous benchmark summary.json.
  --output FILE      Write summary JSON here instead of OUT_DIR/summary.json.

The execution mode is "scripted-selftest", not a real-model rollout. It invokes
mc-selftest.mjs, which requires an already configured and running loopback
server in .mc-server. No server is downloaded, started, stopped, or pointed at
a production world. Token metrics are unavailable unless the input result has
real tokenUsage measurements.
`;

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 64;
  return error;
}

function parseArgs(args) {
  const options = { suite: 'all', runs: 1, summarize: null, baseline: null, output: null, outDir: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--summarize') {
      const paths = [];
      while (index + 1 < args.length && !args[index + 1].startsWith('--')) paths.push(args[++index]);
      if (!paths.length) throw usageError('--summarize requires at least one run directory.');
      options.summarize = paths;
      continue;
    }
    if (!['--suite', '--runs', '--out-dir', '--baseline', '--output'].includes(arg)) {
      throw usageError(`Unknown argument ${JSON.stringify(arg)}. Use --help.`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw usageError(`${arg} requires a value.`);
    if (arg === '--suite') options.suite = value;
    if (arg === '--runs') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
        throw usageError('--runs must be an integer from 1 to 100.');
      }
      options.runs = Number(value);
    }
    if (arg === '--out-dir') options.outDir = value;
    if (arg === '--baseline') options.baseline = value;
    if (arg === '--output') options.output = value;
  }
  if (!SUITES.includes(options.suite) && !options.summarize) {
    throw usageError(`Unknown suite ${JSON.stringify(options.suite)}. Expected: ${SUITES.join(', ')}`);
  }
  if (options.summarize && (options.outDir || args.includes('--suite') || args.includes('--runs'))) {
    throw usageError('--summarize cannot be combined with --suite, --runs, or --out-dir.');
  }
  return options;
}

function runSelfTest(suite, run, eventsFile, resultFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'mc-selftest.mjs'), suite], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        MC_BENCHMARK_EVENTS: eventsFile,
        MC_BENCHMARK_RESULT: resultFile,
        MC_BENCHMARK_RUN: String(run),
      },
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

function loadRun(directory) {
  const resolved = path.resolve(ROOT, directory);
  const dir = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  const resultFile = path.join(dir, 'result.json');
  const eventsFile = path.join(dir, 'events.jsonl');
  const raw = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const events = fs.existsSync(eventsFile) ? parseEventsJsonl(fs.readFileSync(eventsFile, 'utf8'), eventsFile) : [];
  return summarizeRun(raw, events);
}

function readBaseline(file) {
  if (!file) return null;
  const data = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  return data.aggregate ?? data;
}

function stamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${process.pid}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const runs = [];
  let outputDir = null;
  let exitCode = 0;
  if (options.summarize) {
    for (const directory of options.summarize) runs.push(loadRun(directory));
  } else {
    outputDir = path.resolve(ROOT, options.outDir ?? path.join('.mc-benchmark', `${stamp()}-${options.suite}`));
    fs.mkdirSync(outputDir, { recursive: true });
    for (let run = 1; run <= options.runs; run += 1) {
      const runDir = path.join(outputDir, `run-${String(run).padStart(3, '0')}`);
      fs.mkdirSync(runDir, { recursive: false });
      const eventsFile = path.join(runDir, 'events.jsonl');
      const resultFile = path.join(runDir, 'result.json');
      const startedAt = Date.now();
      const code = await runSelfTest(options.suite, run, eventsFile, resultFile);
      if (code !== 0) exitCode = 1;
      if (!fs.existsSync(resultFile)) {
        fs.writeFileSync(resultFile, `${JSON.stringify({
          schemaVersion: 1, suite: options.suite, run, startedAt, endedAt: Date.now(), ok: false,
          scenarios: [], error: { code: 'selftest_exit', exitCode: code },
        }, null, 2)}\n`);
      }
      runs.push(loadRun(runDir));
    }
  }

  const aggregate = summarizeRuns(runs);
  const baseline = readBaseline(options.baseline);
  const summary = {
    schemaVersion: 1,
    mode: options.summarize ? 'offline-summary' : 'scripted-selftest',
    createdAt: new Date().toISOString(),
    suite: options.summarize ? null : options.suite,
    aggregate,
    runs,
    ...(baseline ? { baselineComparison: compareBaseline(aggregate, baseline) } : {}),
  };
  const defaultOutput = outputDir
    ? path.join(outputDir, 'summary.json')
    : path.join('.mc-benchmark', 'offline-summary.json');
  const output = path.resolve(ROOT, options.output ?? defaultOutput);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nBenchmark summary: ${output}`);
  console.log(JSON.stringify(aggregate, null, 2));
  if (baseline) console.log(`Baseline comparison:\n${JSON.stringify(summary.baselineComparison, null, 2)}`);
  return exitCode;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`mc-benchmark: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  },
);
