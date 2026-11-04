#!/usr/bin/env node
/**
 * Manage the disposable Minecraft server used by minecraft-survival.ts.
 * Everything, including the world and logs, stays in the ignored .mc-server
 * directory. This tool never downloads a server or touches DSH game settings.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVER_DIR = path.join(ROOT, '.mc-server');
const JAR = path.join(SERVER_DIR, 'server.jar');
const EULA = path.join(SERVER_DIR, 'eula.txt');
const PROPERTIES = path.join(SERVER_DIR, 'server.properties');
const STATE = path.join(SERVER_DIR, 'managed-server.json');
const LOG = path.join(SERVER_DIR, 'server.log');
const HELP = `Usage: node tools/mc-server.mjs <start|stop|status>

Offline setup (the launcher never downloads anything):
  .mc-server/server.jar         Vanilla Minecraft Java server jar (1.21.4 is tested)
  .mc-server/eula.txt           Must contain eula=true
  .mc-server/server.properties  Local test-server settings, for example:
      server-ip=127.0.0.1
      server-port=25565
      online-mode=false
      level-name=world
      enable-rcon=true
      rcon.port=25575
      rcon.password=<set a local password yourself>

Java 21 or newer must be on PATH, or set MC_JAVA to the Java executable.
The RCON password is read only from server.properties and is never printed.
The world, logs, and PID metadata are confined to the ignored .mc-server
folder; no production server or DSH Minecraft setup is used.

Commands:
  start   Launch the jar with .mc-server as its working directory. This opens
          the configured game and RCON ports on 127.0.0.1. Wait for the server
          to finish starting before running tools/mc-selftest.mjs.
  stop    Ask the managed server to stop over loopback RCON and wait for exit.
          No process is force-killed and the test world is not deleted.
  status  Show managed-process state without connecting to the server.
          Exit codes: 0 running, 3 stopped, 1 invalid state.

Logs: .mc-server/server.log
`;

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 64;
  return error;
}

function assertFile(file, description, hint) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`Missing ${description}: ${file}\n${hint}`);
  }
  if (!stat.isFile()) throw new Error(`Expected ${description} to be a file: ${file}`);
}

function readText(file, description) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing ${description}: ${file}`);
    throw new Error(`Cannot read ${description} at ${file}: ${error?.code ?? error.message}`);
  }
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

function readPort(properties, key, fallback) {
  const raw = properties[key] ?? fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer from 1 to 65535 in ${PROPERTIES}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`${key} must be an integer from 1 to 65535 in ${PROPERTIES}`);
  return port;
}

function loadProperties() {
  const properties = parseProperties(readText(PROPERTIES, 'isolated server properties'));
  if (properties['server-ip'] !== '127.0.0.1') {
    throw new Error(`Set server-ip=127.0.0.1 in ${PROPERTIES}; an empty or non-loopback address is not allowed`);
  }
  if (properties['online-mode'] !== 'false') {
    throw new Error(`Set online-mode=false in ${PROPERTIES}; the SelfTest player uses an offline account`);
  }
  if (properties['enable-rcon'] !== 'true' || !properties['rcon.password']) {
    throw new Error(`Set enable-rcon=true and a non-empty local rcon.password in ${PROPERTIES}`);
  }
  const level = properties['level-name'] || 'world';
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/.test(level) || level.includes('..')) {
    throw new Error(`level-name must be a simple directory name inside .mc-server, not a path: ${PROPERTIES}`);
  }
  const port = readPort(properties, 'server-port', '25565');
  const rconPort = readPort(properties, 'rcon.port', '25575');
  if (port === rconPort) throw new Error(`server-port and rcon.port must differ in ${PROPERTIES}`);
  return { properties, level, port, rconPort, password: properties['rcon.password'] };
}

function loadStartSetup() {
  assertFile(
    JAR,
    'isolated server jar',
    'Place a compatible vanilla server jar there. No download is attempted.',
  );
  const eula = readText(EULA, 'isolated server EULA acceptance');
  if (!/^\s*eula\s*=\s*true\s*$/im.test(eula)) {
    throw new Error(`Set eula=true in ${EULA} after reviewing the Minecraft EULA`);
  }
  return loadProperties();
}

function checkJava() {
  const executable = process.env.MC_JAVA || 'java';
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error) {
    throw new Error(`Cannot run Java (${executable}): ${result.error.message}. Install Java 21+ or set MC_JAVA`);
  }
  if (result.status !== 0) throw new Error(`Java version check failed for ${executable}; install Java 21+ or set MC_JAVA`);
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const version = output.match(/version "([^"]+)"/)?.[1];
  const first = Number(version?.split(/[._-]/)[0]);
  const major = first === 1 ? Number(version?.split(/[._-]/)[1]) : first;
  if (!Number.isFinite(major)) throw new Error(`Cannot determine the Java version for ${executable}`);
  if (major < 21) throw new Error(`Java 21+ is required for the tested server; found Java ${major} at ${executable}`);
  return executable;
}

function readState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Cannot read managed-server state ${STATE}: ${error?.code ?? error.message}`);
  }
  try {
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !Number.isInteger(state.pid) || state.pid <= 0 || state.cwd !== SERVER_DIR) {
      throw new Error('invalid contents');
    }
    return state;
  } catch {
    throw new Error(`Invalid managed-server state ${STATE}; inspect it before removing it manually`);
  }
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeState(pid) {
  try {
    const current = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (current?.pid === pid) fs.unlinkSync(STATE);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function start() {
  const existing = readState();
  if (existing && pidRunning(existing.pid)) {
    console.log(`Isolated test server is already running (pid ${existing.pid}).`);
    return;
  }
  if (existing) removeState(existing.pid);

  const setup = loadStartSetup();
  const java = checkJava();
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  const logFd = fs.openSync(LOG, 'a');
  const child = spawn(java, ['-Xms512M', '-Xmx2G', '-jar', JAR, 'nogui'], {
    cwd: SERVER_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    throw new Error(`Could not launch Java: ${error.message}`);
  } finally {
    fs.closeSync(logFd);
  }

  const state = {
    version: 1,
    pid: child.pid,
    cwd: SERVER_DIR,
    jar: 'server.jar',
    level: setup.level,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  child.unref();
  console.log(`Launched isolated test server (pid ${child.pid}); startup is not necessarily complete.`);
  console.log(`World directory: ${path.join(SERVER_DIR, setup.level)}`);
  console.log(`Server log: ${LOG}`);
}

function packet(id, type, body) {
  const text = Buffer.from(body, 'utf8');
  const buffer = Buffer.alloc(14 + text.length);
  buffer.writeInt32LE(10 + text.length, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  text.copy(buffer, 12);
  return buffer;
}

function sendStop(port, password, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let input = Buffer.alloc(0);
    let authed = false;
    let commandSent = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for loopback RCON')), timeoutMs);
    socket.on('connect', () => socket.write(packet(1, 3, password)));
    socket.on('error', (error) => {
      // Vanilla can close RCON as soon as it accepts stop. The PID wait below
      // verifies shutdown, so a disconnect after sending is not reported alone.
      if (commandSent) finish();
      else finish(new Error(`Cannot reach loopback RCON on port ${port}: ${error.code ?? error.message}`));
    });
    socket.on('close', () => {
      if (commandSent) finish();
      else if (!settled) finish(new Error(`Loopback RCON on port ${port} closed before authentication`));
    });
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4) {
        const length = input.readInt32LE(0);
        if (length < 10 || length > 1_048_576) {
          finish(new Error('Invalid response from loopback RCON'));
          return;
        }
        if (input.length < length + 4) return;
        const id = input.readInt32LE(4);
        input = input.subarray(length + 4);
        if (!authed) {
          if (id === -1) {
            finish(new Error('Loopback RCON rejected the configured password'));
            return;
          }
          if (id !== 1) continue;
          authed = true;
          commandSent = true;
          socket.write(packet(2, 2, 'stop'));
        } else if (id === 2) {
          finish();
          return;
        }
      }
    });
  });
}

async function waitForExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (pidRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

async function stop() {
  const state = readState();
  if (!state) {
    console.log('Isolated test server is not running (no managed-server state).');
    return;
  }
  if (!pidRunning(state.pid)) {
    removeState(state.pid);
    console.log('Isolated test server is not running (removed stale managed-server state).');
    return;
  }

  const setup = loadProperties();
  await sendStop(setup.rconPort, setup.password);
  if (!await waitForExit(state.pid)) {
    throw new Error(`Server pid ${state.pid} is still running 30 seconds after the RCON stop command; inspect ${LOG}`);
  }
  removeState(state.pid);
  console.log('Isolated test server stopped; its world was left in .mc-server.');
}

function status() {
  const state = readState();
  if (!state) {
    console.log('stopped (no managed-server state)');
    process.exitCode = 3;
    return;
  }
  if (!pidRunning(state.pid)) {
    removeState(state.pid);
    console.log('stopped (removed stale managed-server state)');
    process.exitCode = 3;
    return;
  }
  console.log(`running (pid ${state.pid}, isolated world ${path.join(SERVER_DIR, state.level)})`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  if (args.length !== 1 || !['start', 'stop', 'status'].includes(args[0])) {
    throw usageError('Expected exactly one command: start, stop, or status. Use --help for setup instructions.');
  }
  if (args[0] === 'start') await start();
  else if (args[0] === 'stop') await stop();
  else status();
}

main().catch((error) => {
  console.error(`mc-server: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
});
