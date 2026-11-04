import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_ACTIONS,
  SKILL_PRECONDITIONS,
  planFailureRecovery,
  planSkill,
  type MinecraftSkillName,
  type SkillAction,
  type SkillContext,
  type SkillPlanResult,
} from '../src/games/minecraft/skills.js';

function context(inventory: Record<string, number> = {}, extra: Partial<SkillContext> = {}): SkillContext {
  return {
    snapshot: { body: { inventory } },
    ...extra,
  };
}

function actions(result: SkillPlanResult): SkillAction[] {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.actions;
}

const deathPosition = { x: 12.5, y: 64, z: -8.25 };
const buildArgs = {
  blueprintId: 'cabin-v3',
  label: 'cabin',
  blocks: [
    { x: 2, y: 65, z: 0, name: 'minecraft:stone', props: { facing: 'north', half: 'top' } },
    { x: 0, y: 64, z: 0, name: 'oak_planks', props: {} },
    { x: 2, y: 65, z: 0, name: 'stone', props: { half: 'top', facing: 'north' } },
  ],
  clear: [{ x: 1, y: 65, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 1, y: 65, z: 0 }],
  ownedTemporary: [
    { x: 3, y: 64, z: 0, name: 'torch' },
    { x: 0, y: 63, z: 0, name: 'minecraft:dirt' },
    { x: 3, y: 64, z: 0, name: 'torch' },
  ],
};

describe('skill input errors and bounds', () => {
  it('returns typed unsupported-skill errors, including prototype property names', () => {
    expect(planSkill('creativeStock')).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'unsupported_skill', skill: 'creativeStock' }),
    });
    expect(planSkill('toString')).toMatchObject({ ok: false, error: { code: 'unsupported_skill' } });
  });

  it('returns missing, invalid and missing-context errors instead of throwing', () => {
    expect(planSkill('build_resume', {})).toMatchObject({ ok: false, error: { code: 'missing_args', field: 'blueprintId' } });
    expect(planSkill('recover_after_death', {})).toMatchObject({ ok: false, error: { code: 'missing_args', field: 'position' } });
    expect(planSkill('ensure_lighting', { radius: 'large' })).toMatchObject({ ok: false, error: { code: 'invalid_args', field: 'radius' } });
    expect(planSkill('ensure_torches', { targetCount: 8 })).toMatchObject({ ok: false, error: { code: 'missing_context' } });
    expect(planSkill('ensure_tool', { tool: 'laser' }, context())).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
  });

  it('documents preconditions and emits only bounded approved body actions', () => {
    const cases: Array<[MinecraftSkillName, unknown, SkillContext]> = [
      ['ensure_torches', { targetCount: 8 }, context({ torch: 2 })],
      ['ensure_lighting', {}, context()],
      ['ensure_tool', { tool: 'pickaxe' }, context()],
      ['equip_best_loadout', {}, context({ wooden_sword: 1 })],
      ['secure_build_site', buildArgs, context()],
      ['build_resume', buildArgs, context()],
      ['recover_after_death', { position: deathPosition }, context()],
      ['ensure_food', {}, context()],
      ['prepare_for_night', {}, context()],
    ];
    const allowed = new Set([
      'craft_item', 'collect_item', 'ensure_lighting', 'equip', 'go_to', 'pickup_drops',
      'build_structure', 'attack_entity', 'flee', 'hide', 'sleep', 'smelt_item',
    ]);
    expect(Object.keys(SKILL_PRECONDITIONS).sort()).toEqual(cases.map(([skill]) => skill).sort());
    for (const [skill, args, snapshot] of cases) {
      const result = actions(planSkill(skill, args, snapshot));
      expect(result.length).toBeLessThanOrEqual(MAX_SKILL_ACTIONS);
      expect(result.every((step) => allowed.has(step.bodyAction))).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/creativeStock|RCON|teleport|setblock|\bgive\b|\bfill\b/i);
    }
  });
});

describe('torches, lighting and tools', () => {
  it('crafts only the torch deficit relative to the carried total goal', () => {
    expect(actions(planSkill('ensure_torches', { targetCount: 12 }, context({ torch: 5 })))).toEqual([{
      bodyAction: 'craft_item',
      args: { item: 'torch', quantity: 7 },
      label: 'Craft torch deficit x7 (carried 5/12)',
      idempotent: false,
    }]);
    expect(actions(planSkill('ensure_torches', { targetCount: 8 }, context({ torch: 8 })))).toEqual([]);
    expect(actions(planSkill('ensure_torches', { targetCount: 8 }, context({ torch: 20 })))).toEqual([]);
  });

  it('plans lighting without claiming to craft torches', () => {
    const result = actions(planSkill('ensure_lighting', {
      radius: 8,
      verticalRadius: 3,
      maxTorches: 6,
      policy: 'spawn-risk',
      protectedCells: [{ x: 1, y: 64, z: 1 }],
    }, context({ torch: 0 })));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bodyAction: 'ensure_lighting',
      args: {
        radius: 8,
        verticalRadius: 3,
        maxTorches: 6,
        policy: 'spawn-risk',
        protectedCells: [{ x: 1, y: 64, z: 1 }],
      },
      idempotent: true,
    });
    expect(result.some((step) => step.bodyAction === 'craft_item')).toBe(false);
  });

  it('uses an existing suitable tool or crafts one bounded missing tool', () => {
    expect(actions(planSkill('ensure_tool', { tool: 'pickaxe' }, context({ wooden_pickaxe: 1 })))).toEqual([]);
    expect(actions(planSkill('ensure_tool', { tool: 'pickaxe' }, context({ diamond_pickaxe: 1 })))).toEqual([]);
    expect(actions(planSkill('ensure_tool', { tool: 'pickaxe' }, context()))).toMatchObject([
      { bodyAction: 'craft_item', args: { item: 'wooden_pickaxe', quantity: 1 }, idempotent: false },
    ]);
    expect(actions(planSkill('ensure_tool', { tool: 'pickaxe', tier: 'stone' }, context({ wooden_pickaxe: 1 })))).toMatchObject([
      { bodyAction: 'craft_item', args: { item: 'stone_pickaxe', quantity: 1 } },
    ]);
    expect(actions(planSkill('ensure_tool', { item: 'shears' }, context()))).toMatchObject([
      { bodyAction: 'craft_item', args: { item: 'shears', quantity: 1 } },
    ]);
  });
});

describe('equipment and build-site skills', () => {
  it('selects only the best carried loadout in stable slot order', () => {
    const result = actions(planSkill('equip_best_loadout', {}, context({
      wooden_sword: 1,
      diamond_sword: 1,
      shield: 1,
      leather_helmet: 1,
      iron_helmet: 1,
      chainmail_chestplate: 1,
      diamond_chestplate: 1,
      golden_leggings: 1,
      iron_leggings: 1,
      leather_boots: 1,
      netherite_boots: 1,
      dirt: 64,
    })));
    expect(result.map((step) => step.args.item)).toEqual([
      'diamond_sword', 'shield', 'iron_helmet', 'diamond_chestplate', 'iron_leggings', 'netherite_boots',
    ]);
    expect(result).toHaveLength(MAX_SKILL_ACTIONS);
    expect(result.every((step) => step.bodyAction === 'equip' && step.idempotent)).toBe(true);
  });

  it('defends before lighting a hostile build site when a weapon is carried', () => {
    const snapshot = context({ iron_sword: 1 }, {
      snapshot: {
        body: { inventory: { iron_sword: 1 } },
        nearby: { entities: [
          { name: 'skeleton', hostile: true, distance: 8 },
          { name: 'zombie', hostile: true, distance: 3 },
          { name: 'cow', hostile: false, distance: 1 },
        ] },
      },
    });
    expect(actions(planSkill('secure_build_site', buildArgs, snapshot))).toMatchObject([
      { bodyAction: 'attack_entity', args: { entity: 'zombie', quantity: 1, kill: true }, idempotent: false },
    ]);
  });

  it('flees hostiles without a weapon and otherwise lights protected build cells', () => {
    const hostile = context({}, {
      snapshot: {
        body: { inventory: {} },
        nearby: { entities: [{ name: 'zombie', hostile: true, distance: 3 }] },
      },
    });
    expect(actions(planSkill('secure_build_site', buildArgs, hostile))).toMatchObject([{ bodyAction: 'flee' }]);

    const safe = actions(planSkill('secure_build_site', buildArgs, context()));
    expect(safe).toHaveLength(1);
    expect(safe[0].bodyAction).toBe('ensure_lighting');
    expect(safe[0].args.policy).toBe('spawn-risk');
    expect(safe[0].args.protectedCells).toEqual([
      { x: 0, y: 64, z: 0 },
      { x: 0, y: 65, z: 0 },
      { x: 1, y: 65, z: 0 },
      { x: 2, y: 65, z: 0 },
    ]);
  });

  it('preserves canonical build, clear and owned temporary evidence for resume', () => {
    const input = structuredClone(buildArgs);
    const before = structuredClone(input);
    const result = actions(planSkill('build_resume', input, context()));
    expect(input).toEqual(before);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ bodyAction: 'build_structure', idempotent: true });
    expect(result[0].args.blueprintId).toBe('cabin-v3');
    expect(result[0].args.blocks).toEqual([
      { x: 0, y: 64, z: 0, name: 'oak_planks', props: {} },
      { x: 2, y: 65, z: 0, name: 'stone', props: { facing: 'north', half: 'top' } },
    ]);
    expect(result[0].args.clear).toEqual([{ x: 0, y: 65, z: 0 }, { x: 1, y: 65, z: 0 }]);
    expect(result[0].args.ownedTemporary).toEqual([
      { x: 0, y: 63, z: 0, name: 'dirt' },
      { x: 3, y: 64, z: 0, name: 'torch' },
    ]);
  });

  it('rejects conflicting canonical resume cells', () => {
    expect(planSkill('build_resume', {
      ...buildArgs,
      blocks: [
        { x: 0, y: 64, z: 0, name: 'stone', props: {} },
        { x: 0, y: 64, z: 0, name: 'dirt', props: {} },
      ],
    })).toMatchObject({ ok: false, error: { code: 'invalid_args', field: 'blocks' } });
    expect(planSkill('build_resume', { ...buildArgs, clear: [buildArgs.blocks[1]] })).toMatchObject({
      ok: false, error: { code: 'invalid_args', field: 'clear' },
    });
  });
});

describe('death recovery and food acquisition', () => {
  it('returns an ordered go-to then pickup recovery', () => {
    expect(actions(planSkill('recover_after_death', {
      position: deathPosition,
      range: 3,
      radius: 16,
    }, context()))).toEqual([
      {
        bodyAction: 'go_to',
        args: { position: deathPosition, range: 3 },
        label: 'Return to the death position',
        idempotent: true,
      },
      {
        bodyAction: 'pickup_drops',
        args: { radius: 16 },
        label: 'Pick up remaining death drops',
        idempotent: true,
      },
    ]);
  });

  it('honours injected death-drop expiry and handles nearby danger first', () => {
    expect(actions(planSkill('recover_after_death', {
      position: deathPosition,
      expiresAt: 500,
    }, context({}, { now: 500 })))).toEqual([]);
    expect(planSkill('recover_after_death', { position: deathPosition, expiresAt: 500 }, context())).toMatchObject({
      ok: false, error: { code: 'missing_context', field: 'now' },
    });
    const hostile = context({}, {
      snapshot: {
        body: { inventory: {} },
        nearby: { entities: [{ name: 'zombie', hostile: true, distance: 4 }] },
      },
    });
    expect(actions(planSkill('recover_after_death', { position: deathPosition }, hostile))).toMatchObject([
      { bodyAction: 'flee' },
    ]);
  });

  it('does nothing when the carried ready-food goal is met', () => {
    expect(actions(planSkill('ensure_food', { count: 8 }, context({ bread: 5, cooked_beef: 3 })))).toEqual([]);
  });

  it('smelts available raw food instead of replaying collection', () => {
    expect(actions(planSkill('ensure_food', { count: 5 }, context({ beef: 3 })))).toMatchObject([
      { bodyAction: 'smelt_item', args: { item: 'cooked_beef', quantity: 3 }, idempotent: false },
    ]);
  });

  it('crafts bread from real wheat stock or collects missing wheat', () => {
    expect(actions(planSkill('ensure_food', { count: 2 }, context({ wheat: 6 })))).toMatchObject([
      { bodyAction: 'craft_item', args: { item: 'bread', quantity: 2 }, idempotent: false },
    ]);
    expect(actions(planSkill('ensure_food', { item: 'bread', count: 1 }, context({ wheat: 2 })))).toMatchObject([
      { bodyAction: 'collect_item', args: { item: 'wheat', quantity: 3, maxCount: 3 } },
    ]);
  });

  it('falls back to bounded collection or hunting, never an eat action', () => {
    expect(actions(planSkill('ensure_food', { count: 4 }, context()))).toMatchObject([
      { bodyAction: 'collect_item', args: { item: 'apple', quantity: 4, maxCount: 4 } },
    ]);
    expect(actions(planSkill('ensure_food', { item: 'cooked_beef', count: 2 }, context()))).toMatchObject([
      { bodyAction: 'attack_entity', args: { entity: 'cow', quantity: 2, kill: true }, idempotent: false },
    ]);
  });
});

describe('night preparation', () => {
  it('lights first and hides during daytime without inventing crafting', () => {
    const result = actions(planSkill('prepare_for_night', {}, context({}, {
      snapshot: { body: { inventory: {} }, world: { timeOfDay: 6_000 } },
    })));
    expect(result.map((step) => step.bodyAction)).toEqual(['ensure_lighting', 'hide']);
    expect(result[0].args.policy).toBe('spawn-risk');
    expect(result.every((step) => step.idempotent)).toBe(true);
  });

  it('sleeps at night and handles hostiles before either action', () => {
    const night = actions(planSkill('prepare_for_night', {}, context({}, {
      snapshot: { body: { inventory: {} }, world: { timeOfDay: 13_000 } },
    })));
    expect(night.map((step) => step.bodyAction)).toEqual(['ensure_lighting', 'sleep']);
    expect(night[1].idempotent).toBe(false);

    const hostile = context({ wooden_sword: 1 }, {
      snapshot: {
        body: { inventory: { wooden_sword: 1 } },
        world: { timeOfDay: 13_000 },
        nearby: { entities: [{ name: 'zombie', hostile: true, distance: 2 }] },
      },
    });
    expect(actions(planSkill('prepare_for_night', {}, hostile))).toMatchObject([{ bodyAction: 'attack_entity' }]);
  });
});

describe('bounded failure recovery', () => {
  it('selects one canonical missing supply and then exhausts the recovery budget', () => {
    const failure = {
      code: 'missing_item',
      details: { missing: { stick: 2, coal: 4 } },
      idempotent: false,
      certainty: 'certain' as const,
    };
    const first = planFailureRecovery(failure, context());
    expect(first).toMatchObject({
      ok: true,
      disposition: 'supply',
      recoveryAttempts: 1,
      action: { bodyAction: 'collect_item', args: { item: 'coal', quantity: 4, maxCount: 4 } },
    });
    expect(planFailureRecovery({ ...failure, recoveryAttempts: 1 }, context())).toMatchObject({
      ok: true,
      disposition: 'budget_exhausted',
      action: null,
      recoveryAttempts: 1,
    });
  });

  it('returns no automatic recovery for uncertain non-idempotent outcomes', () => {
    expect(planFailureRecovery({
      code: 'missing_item',
      details: { item: 'oak_log', quantity: 2 },
      certainty: 'uncertain',
      idempotent: false,
    }, context())).toMatchObject({
      ok: true,
      disposition: 'needs_decision',
      action: null,
      recoveryAttempts: 0,
    });
  });

  it('maps missing tools, hostiles and low food to at most one new action', () => {
    expect(planFailureRecovery({
      code: 'missing_tool', details: { tool: 'stone_pickaxe' }, certainty: 'certain', idempotent: true,
    }, context())).toMatchObject({
      disposition: 'supply', action: { bodyAction: 'craft_item', args: { item: 'stone_pickaxe', quantity: 1 } },
    });
    expect(planFailureRecovery({
      code: 'unsafe', details: { reason: 'hostiles', entity: 'zombie' }, certainty: 'certain', idempotent: true,
    }, context({ iron_sword: 1 }))).toMatchObject({
      disposition: 'defence', action: { bodyAction: 'attack_entity', args: { entity: 'zombie', quantity: 1 } },
    });
    expect(planFailureRecovery({
      code: 'low_food', certainty: 'certain', idempotent: true,
    }, context({ beef: 2 }))).toMatchObject({
      disposition: 'supply', action: { bodyAction: 'smelt_item', args: { item: 'cooked_beef', quantity: 2 } },
    });
  });

  it('reroutes only to an explicit alternate and returns typed malformed-input errors', () => {
    expect(planFailureRecovery({
      code: 'path_unreachable',
      details: { safePosition: { x: 1, y: 64, z: 2 } },
      certainty: 'certain',
      idempotent: true,
    })).toMatchObject({
      disposition: 'reroute',
      action: { bodyAction: 'go_to', args: { position: { x: 1, y: 64, z: 2 }, range: 1 } },
    });
    expect(planFailureRecovery({ code: 'path_unreachable', certainty: 'certain', idempotent: true })).toMatchObject({
      disposition: 'needs_decision', action: null,
    });
    expect(planFailureRecovery({
      code: 'blocked', details: { reroutePosition: { x: 'bad' } }, certainty: 'certain', idempotent: true,
    })).toMatchObject({ ok: false, error: { code: 'invalid_args', field: 'reroutePosition' } });
  });
});

describe('determinism', () => {
  it('returns identical plans for identical snapshots and args', () => {
    const snapshot = context({ torch: 2, wheat: 6, diamond_sword: 1 });
    expect(planSkill('ensure_torches', { targetCount: 8 }, snapshot))
      .toEqual(planSkill('ensure_torches', { targetCount: 8 }, snapshot));
    expect(planSkill('build_resume', buildArgs, snapshot)).toEqual(planSkill('build_resume', buildArgs, snapshot));
    expect(planFailureRecovery({ code: 'low_food', certainty: 'certain', idempotent: true }, snapshot))
      .toEqual(planFailureRecovery({ code: 'low_food', certainty: 'certain', idempotent: true }, snapshot));
  });
});
