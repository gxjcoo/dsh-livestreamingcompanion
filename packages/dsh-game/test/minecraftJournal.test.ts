import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorldJournal,
  journalFile,
  type MinecraftBuildJobInput,
} from '../src/games/minecraft/journal.js';
import { createPlan, type MinecraftPlan } from '../src/games/minecraft/plan.js';
import type { BuildBlock } from '../src/games/minecraft/body/build.js';

const SERVER = '127.0.0.1:25565';
const USERNAME = 'doki';
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-minecraft-journal-'));
  directories.push(directory);
  return directory;
}

function open(directory: string, seed?: string): WorldJournal {
  return WorldJournal.open(directory, SERVER, USERNAME, seed).journal;
}

function fileFor(directory: string): string {
  return journalFile(directory, SERVER, USERNAME);
}

function writeRaw(directory: string, value: unknown): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(fileFor(directory), JSON.stringify(value, null, 2));
}

function readRaw(directory: string): any {
  return JSON.parse(fs.readFileSync(fileFor(directory), 'utf8'));
}

function block(x: number, y: number, z: number, name = 'stone', props: Record<string, string> = {}): BuildBlock {
  return { x, y, z, name, props };
}

function jobInput(overrides: Partial<MinecraftBuildJobInput> = {}): MinecraftBuildJobInput {
  return {
    id: 'job-cabin',
    planId: 'plan-cabin',
    stepId: 'build-cabin',
    label: 'cabin',
    dimension: 'overworld',
    origin: { x: 10, y: 64, z: -5 },
    blocks: [block(11, 64, -5), block(10, 64, -5, 'oak_door', { facing: 'north', half: 'lower' })],
    clear: [{ x: 10, y: 65, z: -5 }],
    now: 100,
    ...overrides,
  };
}

function plan(id = 'plan-cabin'): MinecraftPlan {
  return createPlan('build a safe cabin', [{
    id: 'build-cabin',
    skill: 'build',
    args: { blueprint: 'cabin', options: { z: 1, a: 2 } },
    completion: { type: 'blueprint_complete', blueprintId: 'cabin' },
  }], { id, now: 50 });
}

const v1Fixture = {
  version: 1,
  server: SERVER,
  username: USERNAME,
  seed: '12345',
  sessions: 2,
  goal: 'build a safe cabin',
  designs: [{ name: 'cabin', text: '# stone', usedAt: 101 }],
  buildings: [{ name: 'cabin', x: 10, y: 64, z: -5, dimension: 'overworld', done: 4, total: 4, at: 102 }],
  fields: [{ crop: 'wheat_seeds', x: 20, y: 63, z: 5, dimension: 'overworld', size: 3, at: 103 }],
  places: [{ name: 'home', x: 10, y: 64, z: -5, dimension: 'overworld', at: 104 }],
  bed: { x: 12, y: 64, z: -5, dimension: 'overworld', at: 105 },
  deaths: [{ x: 0, y: 70, z: 0, dimension: 'the_nether', at: 106 }],
  deathCount: 3,
  portals: [{
    a: { x: 1, y: 64, z: 1, dimension: 'overworld' },
    b: { x: 2, y: 70, z: 2, dimension: 'the_nether' },
    at: 107,
  }],
  last: {
    x: 10,
    y: 64,
    z: -4,
    dimension: 'overworld',
    at: 108,
    doing: 'building',
    inventory: 'stone x4',
  },
};

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('journal v2 migration and legacy display', () => {
  it('migrates v1 to v2 while preserving every legacy field and wrapping its goal', () => {
    const directory = temporaryDirectory();
    writeRaw(directory, v1Fixture);

    const journal = open(directory);
    expect(journal.goal).toBe(v1Fixture.goal);
    expect(journal.activePlan).toMatchObject({ goal: v1Fixture.goal, status: 'active', steps: [] });
    expect(journal.activeJob).toBeUndefined();
    journal.startSession();

    const saved = readRaw(directory);
    expect(saved).toMatchObject({
      ...v1Fixture,
      version: 2,
      sessions: 3,
      activePlan: { version: 1, goal: v1Fixture.goal, status: 'active', steps: [] },
    });
    expect(saved.activeJob).toBeUndefined();
  });

  it('renders old goals, places, builds, fields, portals, bed, deaths and last state', () => {
    const directory = temporaryDirectory();
    writeRaw(directory, v1Fixture);

    const text = WorldJournal.read(directory, SERVER, USERNAME);
    expect(text).toContain('目标：build a safe cabin');
    expect(text).toContain('home (10, 64, -5)');
    expect(text).toContain('「cabin」在 (10, 64, -5)，盖完了');
    expect(text).toContain('wheat_seeds 3×3 在 (20, 63, 5)');
    expect(text).toContain('主世界 (1, 64, 1) ↔ 下界 (2, 70, 2)');
    expect(text).toContain('床（复活点）：(12, 64, -5)');
    expect(text).toContain('死过 3 次，最近一次在 下界 (0, 70, 0)');
    expect(text).toContain('正在building；身上：stone x4');
  });

  it('creates fresh journals as v2 with atomic temp+rename saves', () => {
    const directory = temporaryDirectory();
    const journal = open(directory, 'seed-a');
    expect(journal.activePlan).toBeUndefined();
    expect(journal.activeJob).toBeUndefined();

    journal.startSession();
    expect(readRaw(directory)).toMatchObject({
      version: 2,
      server: SERVER,
      username: USERNAME,
      seed: 'seed-a',
      sessions: 1,
      designs: [],
      buildings: [],
      fields: [],
      places: [],
      deaths: [],
      deathCount: 0,
    });
    expect(fs.existsSync(`${fileFor(directory)}.tmp`)).toBe(false);
  });
});

describe('active structured plans', () => {
  it('round-trips a current plan and returns defensive snapshots', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    const original = plan();
    const saved = journal.setPlan(original);
    expect(saved).toEqual(original);

    saved.goal = 'mutated outside the journal';
    saved.steps[0].args.blueprint = 'other';
    expect(journal.activePlan?.goal).toBe(original.goal);
    expect(journal.activePlan?.steps[0].args.blueprint).toBe('cabin');

    expect(open(directory).activePlan).toEqual(original);
    const legacy = open(directory).setPlan('survive the night', { id: 'legacy-plan', now: 200 });
    expect(legacy).toMatchObject({ id: 'legacy-plan', goal: 'survive the night', steps: [] });
    expect(open(directory).activePlan).toEqual(legacy);
  });

  it('persists shadow mode and handoff receipts after the active plan changes', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    journal.setPlanMode('shadow');
    journal.setPlan(plan('handoff-a'));
    const firstReceipt = journal.planReceipt('handoff-a');
    expect(firstReceipt?.definitionHash).toMatch(/^[a-f0-9]{64}$/);

    journal.setPlan(plan('handoff-b'));
    const restarted = open(directory);
    expect(restarted.planMode).toBe('shadow');
    expect(restarted.activePlan?.id).toBe('handoff-b');
    expect(restarted.planReceipt('handoff-a')).toEqual(firstReceipt);
    expect(restarted.planReceipt('handoff-b')?.id).toBe('handoff-b');

    const snapshot = restarted.planReceipt('handoff-a')!;
    snapshot.definitionHash = 'tampered';
    expect(restarted.planReceipt('handoff-a')).toEqual(firstReceipt);
  });
});

describe('canonical resumable build jobs', () => {
  it('hashes canonical content independently of block, clear and prop ordering', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    const first = journal.createJob(jobInput({
      blocks: [
        block(2, 65, 0, 'oak_door', { half: 'lower', facing: 'north' }),
        block(1, 64, 0),
      ],
      clear: [{ x: 3, y: 65, z: 0 }, { x: 0, y: 65, z: 0 }],
    }));
    journal.clearJob(first.id, 'DONE');
    const second = journal.createJob(jobInput({
      blocks: [
        block(1, 64, 0),
        block(2, 65, 0, 'oak_door', { facing: 'north', half: 'lower' }),
      ],
      clear: [{ x: 0, y: 65, z: 0 }, { x: 3, y: 65, z: 0 }],
    }));

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.blocks).toEqual(first.blocks);
    expect(second.clear).toEqual(first.clear);
    expect(second.blocks.map(({ x }) => x)).toEqual([1, 2]);
    expect(Object.keys(second.blocks[1].props)).toEqual(['facing', 'half']);
  });

  it('persists updates and interruption across restart without trusting a progress cursor', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    journal.setPlan(plan());
    journal.createJob(jobInput());
    journal.updateJob('job-cabin', { phase: 'BUILDING', attempts: 1, now: 110 });
    const interrupted = journal.updateJob('job-cabin', {
      phase: 'RECOVERING',
      interruptionReason: 'session stopped',
      ownedTemporary: [{ x: 12, y: 63, z: -5, name: 'dirt' }],
      now: 120,
    });
    expect(interrupted).toMatchObject({
      phase: 'RECOVERING',
      interruptionReason: 'session stopped',
      attempts: 1,
      maxAttempts: 3,
      createdAt: 100,
      updatedAt: 120,
    });

    const restarted = open(directory);
    restarted.startSession();
    expect(restarted.activeJob).toEqual(interrupted);
    expect(restarted.activeJob).not.toHaveProperty('progressCursor');
    expect(restarted.activeJob).not.toHaveProperty('completed');

    const resumed = restarted.updateJob('job-cabin', {
      phase: 'RESECURING',
      interruptionReason: null,
      attempts: 2,
      now: 130,
    });
    expect(resumed.phase).toBe('RESECURING');
    expect(resumed.interruptionReason).toBeUndefined();
    expect(open(directory).activeJob).toEqual(resumed);
    expect(() => restarted.updateJob('job-cabin', { attempts: 1, now: 140 })).toThrow('nondecreasing');
    expect(() => restarted.updateJob('job-cabin', { now: 129 })).toThrow('backwards');
  });

  it('stores only the explicit ownedTemporary ledger and validates its positions', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    const created = journal.createJob(jobInput({
      ownedTemporary: [
        { x: 9, y: 63, z: -5, name: 'cobblestone' },
        { x: 8, y: 63, z: -5, name: 'dirt' },
      ],
    }));
    expect(created.ownedTemporary.map(({ x }) => x)).toEqual([8, 9]);

    const updated = journal.updateJob(created.id, {
      ownedTemporary: [{ x: 9, y: 63, z: -5, name: 'cobblestone' }],
      now: 101,
    });
    expect(updated.ownedTemporary).toEqual([{ x: 9, y: 63, z: -5, name: 'cobblestone' }]);
    expect(open(directory).activeJob?.ownedTemporary).toEqual(updated.ownedTemporary);
    expect(() => journal.updateJob(created.id, {
      ownedTemporary: [
        { x: 9, y: 63, z: -5, name: 'dirt' },
        { x: 9, y: 63, z: -5, name: 'dirt' },
      ],
      now: 102,
    })).toThrow('duplicate position');
    expect(open(directory).activeJob?.ownedTemporary).toEqual(updated.ownedTemporary);
  });

  it('clears recovery state only for an explicit DONE or ABANDONED outcome', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    journal.createJob(jobInput());
    expect(() => journal.createJob(jobInput({ id: 'other' }))).toThrow('still active');
    expect(() => (journal.clearJob as (id: string, outcome?: string) => boolean)('job-cabin')).toThrow('DONE or ABANDONED');
    expect(journal.activeJob).toBeDefined();
    expect(journal.clearJob('unknown', 'DONE')).toBe(false);

    expect(journal.clearJob('job-cabin', 'DONE')).toBe(true);
    expect(journal.activeJob).toBeUndefined();
    expect(readRaw(directory).activeJob).toBeUndefined();

    journal.createJob(jobInput({ id: 'abandoned-job', now: 200 }));
    expect(journal.clearJob('abandoned-job', 'ABANDONED')).toBe(true);
    expect(open(directory).activeJob).toBeUndefined();
  });

  it('strips signals, callbacks, cursors and block completion metadata from serialized jobs', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    const controller = new AbortController();
    const untrusted = {
      ...jobInput(),
      signal: controller.signal,
      callback: () => 'not serializable',
      progressCursor: 7,
      blocks: [{ ...block(1, 64, 0), completed: true, placedAt: 99 }],
    } as unknown as MinecraftBuildJobInput;

    journal.createJob(untrusted);
    const raw = readRaw(directory).activeJob;
    expect(raw).not.toHaveProperty('signal');
    expect(raw).not.toHaveProperty('callback');
    expect(raw).not.toHaveProperty('progressCursor');
    expect(raw.blocks[0]).toEqual(block(1, 64, 0));
    expect(JSON.stringify(raw)).not.toContain('completed');
    expect(JSON.stringify(raw)).not.toContain('placedAt');
  });

  it('rejects oversized arrays and discards tampered persisted content without hiding old data', () => {
    const directory = temporaryDirectory();
    const journal = open(directory);
    expect(() => journal.createJob(jobInput({
      blocks: new Array(100_001).fill(block(1, 64, 0)),
    }))).toThrow('exceeds');
    expect(journal.activeJob).toBeUndefined();

    journal.setGoal('keep my old goal');
    journal.createJob(jobInput());
    const tampered = readRaw(directory);
    tampered.activeJob.blocks = [];
    tampered.activeJob.progressCursor = 3;
    writeRaw(directory, tampered);

    const restored = open(directory);
    expect(restored.activeJob).toBeUndefined();
    expect(restored.goal).toBe('keep my old goal');
    expect(restored.full()).toContain('目标：keep my old goal');
  });

  it('sets aside the old world on seed change and does not resume its plan or job', () => {
    const directory = temporaryDirectory();
    const journal = open(directory, 'old-seed');
    journal.setPlan(plan());
    journal.createJob(jobInput());

    const swapped = WorldJournal.open(directory, SERVER, USERNAME, 'new-seed');
    expect(swapped.note).toContain('种子变了');
    expect(swapped.journal.activePlan).toBeUndefined();
    expect(swapped.journal.activeJob).toBeUndefined();
    swapped.journal.startSession();
    expect(readRaw(directory)).toMatchObject({ version: 2, seed: 'new-seed', sessions: 1 });

    const archived = fs.readdirSync(directory).find((name) => name.includes('.old-world-'));
    expect(archived).toBeDefined();
    const old = JSON.parse(fs.readFileSync(path.join(directory, archived!), 'utf8'));
    expect(old.activeJob.id).toBe('job-cabin');
    expect(old.activePlan.id).toBe('plan-cabin');
  });
});
