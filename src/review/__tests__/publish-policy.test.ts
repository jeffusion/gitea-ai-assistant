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
  test('empty findings → all arrays empty', () => {
    const result = applyPublishPolicy([]);
    expect(result.publishable).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  test('high severity → publishable regardless of confidence', () => {
    const f = makeFinding({ severity: 'high', confidence: 0.2 });
    const result = applyPublishPolicy([f]);
    expect(result.publishable).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test('medium severity → publishable regardless of confidence', () => {
    const f = makeFinding({ severity: 'medium', confidence: 0.2 });
    const result = applyPublishPolicy([f]);
    expect(result.publishable).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test('low severity → dropped even with high confidence', () => {
    const f = makeFinding({ severity: 'low', confidence: 0.95 });
    const result = applyPublishPolicy([f]);
    expect(result.publishable).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  test('mixed findings split correctly', () => {
    const findings: TestFinding[] = [
      makeFinding({ severity: 'high', confidence: 0.95 }),
      makeFinding({ severity: 'medium', confidence: 0.85 }),
      makeFinding({ severity: 'low', confidence: 0.9 }),
    ];
    const result = applyPublishPolicy(findings);
    expect(result.publishable).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
  });

  test('all findings same fingerprint → all processed independently', () => {
    const fp = 'shared-fingerprint';
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: fp, severity: 'high', confidence: 0.9 }),
      makeFinding({ fingerprint: fp, severity: 'medium', confidence: 0.85 }),
      makeFinding({ fingerprint: fp, severity: 'low', confidence: 0.95 }),
    ];
    const result = applyPublishPolicy(findings);
    expect(result.publishable).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
  });

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
    const result = applyPublishPolicy([f]);
    expect(result.publishable[0]).toEqual(f);
  });
});
