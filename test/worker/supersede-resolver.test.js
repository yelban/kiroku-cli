import { describe, expect, it } from 'vitest';
import { resolveSemanticSupersedes } from '../../src/worker/supersede-resolver.js';

function vectorWithCosine(cosine) {
  return [cosine, Math.sqrt(1 - cosine * cosine)];
}

const candidateBase = {
  id: 'fact_new',
  subjectEntityId: 'ent_subject',
  predicate: 'standardizes on database',
  objectText: 'SQLite',
  factType: 'semantic',
  embedding: [1, 0],
};

const targetBase = {
  id: 'fact_old',
  subjectEntityId: 'ent_subject',
  predicate: 'selected storage engine',
  objectText: 'Lowdb',
  factType: 'semantic',
  embedding: [1, 0],
};

describe('resolveSemanticSupersedes', () => {
  it('supersedes semantic facts when cosine reaches the semantic threshold', () => {
    const decisions = resolveSemanticSupersedes(candidateBase, [targetBase], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions).toEqual([expect.objectContaining({
      action: 'supersede',
      sourceFactId: 'fact_new',
      targetFactId: 'fact_old',
      cosine: 1,
      threshold: 0.58,
    })]);
  });

  it('archives state and task facts using the state/task threshold', () => {
    const candidate = {
      ...candidateBase,
      predicate: 'was fixed by',
      objectText: 'guarding the missing state parameter',
      embedding: [1, 0],
    };
    const target = {
      ...targetBase,
      predicate: 'currently fails with',
      objectText: '500 on missing state parameter',
      factType: 'state',
      embedding: vectorWithCosine(0.8),
    };

    const decisions = resolveSemanticSupersedes(candidate, [target], {
      semanticThreshold: 0.88,
      stateTaskThreshold: 0.8,
    });

    expect(decisions[0]).toMatchObject({
      action: 'archive',
      targetFactId: 'fact_old',
      threshold: 0.8,
    });
    expect(decisions[0].cosine).toBeCloseTo(0.8);
  });

  it('treats the threshold as inclusive and leaves below-threshold facts active', () => {
    const atThreshold = resolveSemanticSupersedes(candidateBase, [{
      ...targetBase,
      id: 'fact_at_threshold',
      embedding: vectorWithCosine(0.58),
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });
    const belowThreshold = resolveSemanticSupersedes(candidateBase, [{
      ...targetBase,
      id: 'fact_below_threshold',
      embedding: vectorWithCosine(0.579),
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(atThreshold[0].action).toBe('supersede');
    expect(belowThreshold[0]).toMatchObject({
      action: 'none',
      targetFactId: 'fact_below_threshold',
      reason: 'below_threshold',
    });
  });

  it('does not supersede when object text is identical', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      objectText: 'SQLite',
    }, [{
      ...targetBase,
      objectText: 'SQLite',
      embedding: [1, 0],
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions).toEqual([expect.objectContaining({
      action: 'none',
      reason: 'same_object',
    })]);
  });

  it('lets update operation waive the same-object guard and supersede the target', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      predicate: 'records current dependency',
      objectText: 'left-pad',
      operation: 'update',
      confidence: 0.8,
      embedding: [1, 0],
    }, [{
      ...targetBase,
      predicate: 'depends on',
      objectText: 'left-pad',
      embedding: vectorWithCosine(0.58),
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions[0]).toMatchObject({
      action: 'supersede',
      operation: 'update',
      confidence: 0.8,
      targetFactId: 'fact_old',
      threshold: 0.58,
    });
    expect(decisions[0].cosine).toBeCloseTo(0.58);
  });

  it('lets delete operation waive replacement-signal and same-object guards and archive the target', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      predicate: 'documents removal',
      objectText: 'left-pad',
      operation: 'delete',
      confidence: 0.9,
      embedding: [1, 0],
    }, [{
      ...targetBase,
      predicate: 'depends on',
      objectText: 'left-pad',
      embedding: vectorWithCosine(0.84),
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions[0]).toMatchObject({
      action: 'archive',
      operation: 'delete',
      confidence: 0.9,
      targetFactId: 'fact_old',
      threshold: 0.58,
    });
    expect(decisions[0].cosine).toBeCloseTo(0.84);
  });

  it('uses an inclusive 0.8 confidence gate for operation decisions', () => {
    const operationCandidate = {
      ...candidateBase,
      predicate: 'marks stale dependency',
      objectText: 'left-pad',
      operation: 'delete',
      embedding: [1, 0],
    };
    const operationTarget = {
      ...targetBase,
      predicate: 'depends on',
      objectText: 'left-pad',
      embedding: vectorWithCosine(0.84),
    };

    const atGate = resolveSemanticSupersedes({
      ...operationCandidate,
      confidence: 0.8,
    }, [operationTarget], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });
    const belowGate = resolveSemanticSupersedes({
      ...operationCandidate,
      confidence: 0.799,
    }, [operationTarget], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(atGate[0]).toMatchObject({
      action: 'archive',
      operation: 'delete',
      confidence: 0.8,
    });
    expect(belowGate[0]).toMatchObject({
      action: 'skip',
      reason: 'operation_confidence_below_threshold',
      operation: 'delete',
      confidence: 0.799,
      operationConfidenceThreshold: 0.8,
      targetFactId: 'fact_old',
    });
    expect(belowGate[0].cosine).toBeCloseTo(0.84);
  });

  it('degrades to no semantic decisions without embeddings', () => {
    expect(resolveSemanticSupersedes({ ...candidateBase, embedding: null }, [targetBase])).toEqual([]);
    expect(resolveSemanticSupersedes(candidateBase, [{ ...targetBase, embedding: null }])).toEqual([
      expect.objectContaining({
        action: 'none',
        reason: 'missing_target_embedding',
      }),
    ]);
  });

  it('recognizes CJK replacement cues', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      predicate: '改用',
      objectText: 'pnpm 作為套件管理器',
      embedding: [1, 0],
    }, [{
      ...targetBase,
      predicate: 'uses package manager',
      objectText: 'npm',
      embedding: [1, 0],
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions).toEqual([expect.objectContaining({
      action: 'supersede',
      targetFactId: 'fact_old',
    })]);
  });

  it('ignores words that merely contain a cue (G15: no substring false fire)', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      predicate: 'requires env var',
      objectText: 'CACHE_PREFIX set', // 'prefix' contains 'fix'
      embedding: [1, 0],
    }, [{
      ...targetBase,
      predicate: 'requires env var',
      objectText: 'CACHE_HOST set',
      embedding: vectorWithCosine(0.95),
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions).toEqual([expect.objectContaining({
      action: 'none',
      reason: 'no_replacement_signal',
    })]);
  });

  it('still fires on a word-boundary cue, including sentence-final now', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      predicate: 'is the storage engine now',
      objectText: 'SQLite',
      embedding: [1, 0],
    }, [targetBase], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions).toEqual([expect.objectContaining({
      action: 'supersede',
      targetFactId: 'fact_old',
    })]);
  });

  it('does not kill complementary same-subject semantic facts without replacement cues', () => {
    const decisions = resolveSemanticSupersedes({
      ...candidateBase,
      predicate: 'persists checkpoints',
      objectText: 'in the jobs table',
      embedding: [1, 0],
    }, [{
      ...targetBase,
      predicate: 'uses cursor tokens',
      objectText: 'for pagination checkpoints',
      embedding: [1, 0],
    }], {
      semanticThreshold: 0.58,
      stateTaskThreshold: 0.8,
    });

    expect(decisions).toEqual([expect.objectContaining({
      action: 'none',
      reason: 'no_replacement_signal',
    })]);
  });
});
