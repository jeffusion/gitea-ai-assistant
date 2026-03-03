import { describe, expect, test } from 'bun:test';
import { applyPublishPolicy } from '../policy/publish-policy';
import type { Finding } from '../types';

type TestFinding = Omit<Finding, 'id' | 'runId' | 'published'>;

function makeFinding(overrides: Partial<TestFinding> = {}): TestFinding {
  return {
    fingerprint: `fp-${Math.random().toString(36).slice(2, 8)}`,
    category: 'correctness',
    severity: 'medium',
    confidence: 0.9,
    path: 'src/foo.ts',
    line: 10,
    title: 'Test finding',
    detail: 'Detail',
    evidence: 'Evidence',
    suggestion: 'Fix it',
    ...overrides,
  };
}

describe('applyPublishPolicy', () => {
  const MIN_CONFIDENCE = 0.8;

  // ─── Empty input ───
  test('empty findings → all arrays empty', () => {
    const result = applyPublishPolicy([], MIN_CONFIDENCE, false);
    expect(result.publishable).toEqual([]);
    expect(result.gated).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  // ─── High confidence + medium/high severity → publishable ───
  test('high severity + high confidence → publishable (humanGate off)', () => {
    const f = makeFinding({ severity: 'high', confidence: 0.95 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(1);
    expect(result.gated).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  test('medium severity + high confidence → publishable (humanGate off)', () => {
    const f = makeFinding({ severity: 'medium', confidence: 0.85 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(1);
    expect(result.gated).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  test('high severity + exactly at threshold → publishable', () => {
    const f = makeFinding({ severity: 'high', confidence: 0.8 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(1);
  });

  // ─── Low severity → never publishable (even with high confidence) ───
  test('low severity + high confidence → dropped (humanGate off)', () => {
    const f = makeFinding({ severity: 'low', confidence: 0.95 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(0);
    expect(result.gated).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  test('low severity + high confidence → gated (humanGate on)', () => {
    const f = makeFinding({ severity: 'low', confidence: 0.95 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, true);
    expect(result.publishable).toHaveLength(0);
    expect(result.gated).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  // ─── Low confidence → not publishable ───
  test('high severity + low confidence → dropped (humanGate off)', () => {
    const f = makeFinding({ severity: 'high', confidence: 0.5 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  test('high severity + low confidence → gated (humanGate on)', () => {
    const f = makeFinding({ severity: 'high', confidence: 0.5 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, true);
    expect(result.publishable).toHaveLength(0);
    expect(result.gated).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test('medium severity + below threshold → dropped (humanGate off)', () => {
    const f = makeFinding({ severity: 'medium', confidence: 0.7 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  test('medium severity + below threshold → gated (humanGate on)', () => {
    const f = makeFinding({ severity: 'medium', confidence: 0.7 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, true);
    expect(result.publishable).toHaveLength(0);
    expect(result.gated).toHaveLength(1);
  });

  // ─── Human gate ON: non-publishable → always gated, never dropped ───
  test('humanGate on: low confidence low severity → gated', () => {
    const f = makeFinding({ severity: 'low', confidence: 0.3 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, true);
    expect(result.publishable).toHaveLength(0);
    expect(result.gated).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  // ─── Mixed findings ───
  test('mixed findings split correctly', () => {
    const findings: TestFinding[] = [
      makeFinding({ severity: 'high', confidence: 0.95 }), // → publishable
      makeFinding({ severity: 'medium', confidence: 0.85 }), // → publishable
      makeFinding({ severity: 'low', confidence: 0.9 }), // → dropped (low severity, humanGate off)
      makeFinding({ severity: 'high', confidence: 0.5 }), // → dropped (low confidence)
      makeFinding({ severity: 'medium', confidence: 0.6 }), // → dropped (low confidence)
    ];
    const result = applyPublishPolicy(findings, MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(2);
    expect(result.gated).toHaveLength(0);
    expect(result.dropped).toHaveLength(3);
  });

  test('mixed findings with humanGate on', () => {
    const findings: TestFinding[] = [
      makeFinding({ severity: 'high', confidence: 0.95 }), // → publishable
      makeFinding({ severity: 'low', confidence: 0.9 }), // → gated
      makeFinding({ severity: 'high', confidence: 0.5 }), // → gated
    ];
    const result = applyPublishPolicy(findings, MIN_CONFIDENCE, true);
    expect(result.publishable).toHaveLength(1);
    expect(result.gated).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  // ─── Boundary: confidence exactly at threshold ───
  test('confidence exactly at threshold + medium severity → publishable', () => {
    const f = makeFinding({ severity: 'medium', confidence: MIN_CONFIDENCE });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable).toHaveLength(1);
  });

  test('confidence just below threshold + medium severity → dropped', () => {
    const f = makeFinding({ severity: 'medium', confidence: MIN_CONFIDENCE - 0.01 });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.dropped).toHaveLength(1);
  });

  // ─── All same fingerprint (policy doesn't dedup, that's judge's job) ───
  test('all findings same fingerprint → all processed independently', () => {
    const fp = 'shared-fingerprint';
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: fp, severity: 'high', confidence: 0.9 }),
      makeFinding({ fingerprint: fp, severity: 'medium', confidence: 0.85 }),
      makeFinding({ fingerprint: fp, severity: 'low', confidence: 0.95 }),
    ];
    const result = applyPublishPolicy(findings, MIN_CONFIDENCE, false);
    // Policy doesn't care about fingerprint - each finding evaluated independently
    expect(result.publishable).toHaveLength(2); // high+medium
    expect(result.dropped).toHaveLength(1); // low severity
  });

  // ─── Different minConfidence thresholds ───
  test('very low threshold → more findings publishable', () => {
    const f = makeFinding({ severity: 'medium', confidence: 0.3 });
    const result = applyPublishPolicy([f], 0.1, false);
    expect(result.publishable).toHaveLength(1);
  });

  test('very high threshold → more findings dropped', () => {
    const f = makeFinding({ severity: 'high', confidence: 0.95 });
    const result = applyPublishPolicy([f], 0.99, false);
    expect(result.dropped).toHaveLength(1);
  });

  // ─── Return value structure ───
  test('returned findings preserve all original fields', () => {
    const f = makeFinding({
      severity: 'high',
      confidence: 0.95,
      path: 'src/important.ts',
      line: 42,
      title: 'Critical bug',
      detail: 'Detailed explanation',
      evidence: 'Code snippet',
      suggestion: 'Fix suggestion',
      category: 'security',
      fingerprint: 'unique-fp-123',
    });
    const result = applyPublishPolicy([f], MIN_CONFIDENCE, false);
    expect(result.publishable[0]).toEqual(f);
  });
});
