import { describe, expect, it } from 'vitest';
import { planMoveOperation, planMoveOperations } from '../../src/worker/move-planner.js';

const fromEntity = {
  id: 'ent_old',
  canonicalName: 'src/legacy/cache.js',
  aliases: ['legacy cache adapter'],
};

const toEntity = {
  id: 'ent_new',
  canonicalName: 'src/cache/adapter.js',
  aliases: ['cache adapter module'],
};

describe('planMoveOperation', () => {
  it('merges the from entity identity into the to entity aliases', () => {
    const plan = planMoveOperation({
      sourceFact: { id: 'fact_move', operation: 'move', confidence: 0.8 },
      fromEntity,
      toEntity,
      fromFacts: [],
      operationConfidenceThreshold: 0.8,
    });

    expect(plan).toMatchObject({
      action: 'move',
      result: 'applied',
      sourceFactId: 'fact_move',
      fromEntityId: 'ent_old',
      toEntityId: 'ent_new',
    });
    expect(plan.aliasMerge).toEqual({
      targetEntityId: 'ent_new',
      aliases: ['cache adapter module', 'src/legacy/cache.js', 'legacy cache adapter'],
      addedAliases: ['src/legacy/cache.js', 'legacy cache adapter'],
    });
  });

  it('plans active from-entity facts for supersede and leaves inactive facts alone', () => {
    const plan = planMoveOperation({
      sourceFact: { id: 'fact_move', operation: 'move', confidence: 1 },
      fromEntity,
      toEntity,
      fromFacts: [
        { id: 'fact_old_path', status: 'active' },
        { id: 'fact_old_detail', status: 'active' },
        { id: 'fact_archived', status: 'archived' },
      ],
      operationConfidenceThreshold: 0.8,
    });

    expect(plan.supersedeFacts).toEqual([
      { factId: 'fact_old_path', status: 'superseded' },
      { factId: 'fact_old_detail', status: 'superseded' },
    ]);
    expect(plan.targetFactIds).toEqual(['fact_old_path', 'fact_old_detail']);
  });

  it('plans refactor batches one move at a time without mixing source facts', () => {
    const plans = planMoveOperations([
      {
        sourceFact: { id: 'fact_move_cache', operation: 'move', confidence: 1 },
        fromEntity: { id: 'ent_cache_old', canonicalName: 'src/legacy/cache.js', aliases: [] },
        toEntity: { id: 'ent_cache_new', canonicalName: 'src/cache/adapter.js', aliases: [] },
        fromFacts: [{ id: 'fact_cache_old', status: 'active' }],
      },
      {
        sourceFact: { id: 'fact_move_auth', operation: 'move', confidence: 1 },
        fromEntity: { id: 'ent_auth_old', canonicalName: 'src/legacy/auth.js', aliases: [] },
        toEntity: { id: 'ent_auth_new', canonicalName: 'src/auth/session.js', aliases: [] },
        fromFacts: [{ id: 'fact_auth_old', status: 'active' }],
      },
    ], { operationConfidenceThreshold: 0.8 });

    expect(plans.map(plan => plan.targetFactIds)).toEqual([
      ['fact_cache_old'],
      ['fact_auth_old'],
    ]);
    expect(plans.map(plan => plan.aliasMerge.addedAliases)).toEqual([
      ['src/legacy/cache.js'],
      ['src/legacy/auth.js'],
    ]);
  });

  it('uses an inclusive confidence gate and skips side effects below it', () => {
    const atGate = planMoveOperation({
      sourceFact: { id: 'fact_at_gate', operation: 'move', confidence: 0.8 },
      fromEntity,
      toEntity,
      fromFacts: [{ id: 'fact_old', status: 'active' }],
      operationConfidenceThreshold: 0.8,
    });
    const belowGate = planMoveOperation({
      sourceFact: { id: 'fact_below_gate', operation: 'move', confidence: 0.799 },
      fromEntity,
      toEntity,
      fromFacts: [{ id: 'fact_old', status: 'active' }],
      operationConfidenceThreshold: 0.8,
    });

    expect(atGate).toMatchObject({
      result: 'applied',
      action: 'move',
      targetFactIds: ['fact_old'],
    });
    expect(belowGate).toMatchObject({
      result: 'skipped',
      action: 'skip',
      reason: 'operation_confidence_below_threshold',
      confidence: 0.799,
      operationConfidenceThreshold: 0.8,
      targetFactIds: [],
    });
    expect(belowGate.aliasMerge).toBeNull();
    expect(belowGate.supersedeFacts).toEqual([]);
  });
});
