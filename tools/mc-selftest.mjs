#!/usr/bin/env node
/**
 * Build dsh-game and run its real Minecraft survival integration test.
 * The test is bundled with the workspace's existing esbuild dependency; no
 * package installation, server download, or server startup is performed here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GAME = path.join(ROOT, 'packages', 'dsh-game');
const SERVER_DIR = path.join(ROOT, '.mc-server');
const PROPERTIES = path.join(SERVER_DIR, 'server.properties');
const STATE = path.join(SERVER_DIR, 'managed-server.json');
const TEST = path.join(GAME, 'test', 'minecraft-survival.ts');
const RUNNABLE_TEST = path.join(GAME, 'lib', 'minecraft-survival.mjs');
const SUITES = ['all', 'basic', 'edge', 'breath', 'build', 'lighting', 'secure-build', 'resume', 'failure-loop', 'farm', 'journal', 'nether', 'creative', 'rcon', 'live'];
const HELP = `Usage: node tools/mc-selftest.mjs [SUITE] [PICK]

Run packages/dsh-game/test/minecraft-survival.ts with its CLI contract:
  argv[2] = repository ROOT (supplied by this launcher)
  argv[3] = SUITE (default: all)
  argv[4] = PICK (default: empty)

SUITE:
  all, basic, edge, breath, build, lighting, secure-build, resume, failure-loop,
  farm, journal, nether, creative, rcon, live

PICK is passed through unchanged and currently filters labelled live cases.
Whitespace is ignored by the test's live-case matcher. Quote PICK if it
contains spaces, for example:
  node tools/mc-selftest.mjs live "直播 3"

Prerequisites:
  1. Configure .mc-server as described by node tools/mc-server.mjs --help.
  2. Run node tools/mc-server.mjs start and wait until its log says it is ready.
  3. Keep Java and the isolated server running for the whole test.

The launcher verifies the managed isolated-server setup before doing work.
It runs the package's normal "npm run build" (which builds the worker), uses
the existing esbuild dependency to make minecraft-survival.ts runnable by
Node, then propagates the build/test exit code. It does not install packages,
download a server, start/stop a server, or use a production world.

This is a real integration test: after this point it connects to loopback
Minecraft and RCON and modifies only the isolated .mc-server world.
`;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function parseProperties(text) {
  const properties = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    properties[line.slice(0, at)] = line.slice(at + 1);
  }
  return properties;
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function preflight() {
  for (const [file, description] of [
    [path.join(SERVER_DIR, 'server.jar'), 'isolated server jar'],
    [path.join(SERVER_DIR, 'eula.txt'), 'isolated server EULA file'],
    [PROPERTIES, 'isolated server properties'],
    [STATE, 'managed-server state'],
    [TEST, 'Minecraft survival test'],
  ]) {
    try {
      if (!fs.statSync(file).isFile()) fail(`Expected ${description} to be a file: ${file}`, 2);
    } catch (error) {
      if (error?.exitCode) throw error;
      fail(`Missing ${description}: ${file}\nConfigure and start the isolated server with tools/mc-server.mjs first.`, 2);
    }
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    fail(`Invalid managed-server state ${STATE}; inspect it with node tools/mc-server.mjs status.`, 2);
  }
  if (state?.version !== 1 || !Number.isInteger(state.pid) || state.pid <= 0 || state.cwd !== SERVER_DIR) {
    fail(`Managed-server state does not belong to this isolated directory: ${STATE}`, 2);
  }
  if (!pidRunning(state.pid)) {
    fail('The managed isolated server is not running. Start it with node tools/mc-server.mjs start and wait for readiness.', 2);
  }

  let properties;
  try {
    properties = parseProperties(fs.readFileSync(PROPERTIES, 'utf8'));
  } catch (error) {
    fail(`Cannot read isolated server properties: ${error?.code ?? error.message}`, 2);
  }
  if (properties['server-ip'] !== '127.0.0.1' || properties['online-mode'] !== 'false') {
    fail(`The isolated test requires server-ip=127.0.0.1 and online-mode=false in ${PROPERTIES}`, 2);
  }
  if (properties['enable-rcon'] !== 'true' || !properties['rcon.password']) {
    fail(`The isolated test requires enable-rcon=true and a local rcon.password in ${PROPERTIES}`, 2);
  }
  const level = properties['level-name'] || 'world';
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/.test(level) || level.includes('..')) {
    fail(`level-name must be a simple directory inside .mc-server, not a path: ${PROPERTIES}`, 2);
  }
  return state;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (signal) {
        console.error(`${command} was terminated by ${signal}.`);
        resolve(128 + (os.constants.signals[signal] ?? 0));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

async function packageBuild() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('Building dsh-game with its package build script...');
  return run(npm, ['run', 'build'], {
    cwd: GAME,
    shell: process.platform === 'win32',
  });
}

async function makeTestRunnable() {
  const requireFromGame = createRequire(path.join(GAME, 'package.json'));
  let esbuild;
  try {
    esbuild = requireFromGame('esbuild');
  } catch {
    fail('The existing dsh-game esbuild dependency is unavailable. Install the locked workspace dependencies before running the self-test.');
  }
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [TEST],
    outfile: RUNNABLE_TEST,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    console.log(HELP);
    return 0;
  }
  if (args.length > 2) fail('Expected at most SUITE and PICK. Use --help for the CLI contract.', 64);
  const suite = args[0] ?? 'all';
  const pick = args[1] ?? '';
  if (!SUITES.includes(suite)) fail(`Unknown SUITE ${JSON.stringify(suite)}. Expected one of: ${SUITES.join(', ')}`, 64);

  const state = preflight();
  fs.mkdirSync(path.join(GAME, 'test', '.out'), { recursive: true });
  const buildCode = await packageBuild();
  if (buildCode !== 0) return buildCode;
  await makeTestRunnable();

  console.log(`Running isolated Minecraft integration suite ${suite}${pick ? ` with PICK ${JSON.stringify(pick)}` : ''}...`);
  console.log(`Managed server pid ${state.pid}; repository ROOT ${ROOT}`);
  return run(process.execPath, [RUNNABLE_TEST, ROOT, suite, pick], { cwd: ROOT });
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`mc-selftest: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  },
);
