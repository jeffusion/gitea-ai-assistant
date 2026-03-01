import { describe, test, expect } from 'bun:test';
import { JudgeAgent } from '../agents/judge-agent';
import type { Finding } from '../types';

type TestFinding = Omit<Finding, 'id' | 'runId' | 'published'>;

function makeFinding(overrides: Partial<TestFinding> = {}): TestFinding {
  return {
    fingerprint: 'fp-' + Math.random().toString(36).slice(2, 8),
    category: 'correctness',
    severity: 'medium',
    confidence: 0.8,
    path: 'src/foo.ts',
    line: 10,
    title: 'Test issue',
    detail: 'Detail',
    evidence: 'Evidence',
    suggestion: 'Fix it',
    ...overrides,
  };
}

describe('JudgeAgent', () => {
  const judge = new JudgeAgent();

  // ─── Empty input ───
  test('empty findings → summary says 未发现', () => {
    const result = judge.judge([]);
    expect(result.findings).toHaveLength(0);
    expect(result.summaryMarkdown).toContain('未发现');
  });

  // ─── Deduplication by fingerprint ───
  test('duplicate fingerprints → keeps highest weighted', () => {
    const fp = 'same-fingerprint';
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: fp, severity: 'low', confidence: 0.9 }),     // weight: 1 * 0.9 = 0.9
      makeFinding({ fingerprint: fp, severity: 'high', confidence: 0.5 }),    // weight: 3 * 0.5 = 1.5  ← winner
      makeFinding({ fingerprint: fp, severity: 'medium', confidence: 0.6 }), // weight: 2 * 0.6 = 1.2
    ];
    const result = judge.judge(findings);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].confidence).toBe(0.5);
  });

  test('same fingerprint same weight → first one wins (no override)', () => {
    const fp = 'dup-fp';
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: fp, severity: 'high', confidence: 0.5, title: 'First' }),
      makeFinding({ fingerprint: fp, severity: 'high', confidence: 0.5, title: 'Second' }),
    ];
    const result = judge.judge(findings);
    expect(result.findings).toHaveLength(1);
    // Same weight → second does NOT override (currentWeight > existingWeight is strict >)
    expect(result.findings[0].title).toBe('First');
  });

  // ─── Sorting by severity × confidence ───
  test('findings sorted by weight descending', () => {
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: 'a', severity: 'low', confidence: 0.9 }),     // 1 * 0.9 = 0.9
      makeFinding({ fingerprint: 'b', severity: 'high', confidence: 0.8 }),    // 3 * 0.8 = 2.4
      makeFinding({ fingerprint: 'c', severity: 'medium', confidence: 0.7 }), // 2 * 0.7 = 1.4
    ];
    const result = judge.judge(findings);
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].fingerprint).toBe('b'); // weight 2.4
    expect(result.findings[1].fingerprint).toBe('c'); // weight 1.4
    expect(result.findings[2].fingerprint).toBe('a'); // weight 0.9
  });

  // ─── Summary text ───
  test('summary counts by severity', () => {
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: 'a', severity: 'high', confidence: 0.9 }),
      makeFinding({ fingerprint: 'b', severity: 'high', confidence: 0.85 }),
      makeFinding({ fingerprint: 'c', severity: 'medium', confidence: 0.8 }),
      makeFinding({ fingerprint: 'd', severity: 'low', confidence: 0.7 }),
    ];
    const result = judge.judge(findings);
    expect(result.summaryMarkdown).toContain('4 个问题');
    expect(result.summaryMarkdown).toContain('high 2');
    expect(result.summaryMarkdown).toContain('medium 1');
    expect(result.summaryMarkdown).toContain('low 1');
  });

  test('single finding → counts correctly', () => {
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: 'x', severity: 'medium', confidence: 0.8 }),
    ];
    const result = judge.judge(findings);
    expect(result.summaryMarkdown).toContain('1 个问题');
    expect(result.summaryMarkdown).toContain('high 0');
    expect(result.summaryMarkdown).toContain('medium 1');
    expect(result.summaryMarkdown).toContain('low 0');
  });

  // ─── Dedup + sort combined ───
  test('dedup then sort: complex scenario', () => {
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: 'x', severity: 'low', confidence: 0.3 }),     // weight 0.3 — will be overridden
      makeFinding({ fingerprint: 'y', severity: 'high', confidence: 0.9 }),    // weight 2.7 — unique
      makeFinding({ fingerprint: 'x', severity: 'medium', confidence: 0.8 }), // weight 1.6 — overrides x
      makeFinding({ fingerprint: 'z', severity: 'high', confidence: 0.5 }),    // weight 1.5 — unique
    ];
    const result = judge.judge(findings);
    expect(result.findings).toHaveLength(3); // x, y, z (deduped)
    // Sorted by weight: y(2.7) > x(1.6) > z(1.5)
    expect(result.findings[0].fingerprint).toBe('y');
    expect(result.findings[1].fingerprint).toBe('x');
    expect(result.findings[1].severity).toBe('medium'); // overridden version
    expect(result.findings[2].fingerprint).toBe('z');
  });

  // ─── All same severity ───
  test('all high severity → sorted by confidence descending', () => {
    const findings: TestFinding[] = [
      makeFinding({ fingerprint: 'a', severity: 'high', confidence: 0.5 }),
      makeFinding({ fingerprint: 'b', severity: 'high', confidence: 0.9 }),
      makeFinding({ fingerprint: 'c', severity: 'high', confidence: 0.7 }),
    ];
    const result = judge.judge(findings);
    expect(result.findings[0].fingerprint).toBe('b');
    expect(result.findings[1].fingerprint).toBe('c');
    expect(result.findings[2].fingerprint).toBe('a');
  });

  // ─── Return type structure ───
  test('result has summaryMarkdown and findings', () => {
    const result = judge.judge([]);
    expect(result).toHaveProperty('summaryMarkdown');
    expect(result).toHaveProperty('findings');
    expect(typeof result.summaryMarkdown).toBe('string');
    expect(Array.isArray(result.findings)).toBe(true);
  });
});
