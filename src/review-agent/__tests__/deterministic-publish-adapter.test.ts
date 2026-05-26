import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { applyDeterministicPublishAdapter } from '../deterministic-publish-adapter';
import type { ReviewAgentFinding } from '../tools';

function makeFinding(overrides: Partial<ReviewAgentFinding> = {}): ReviewAgentFinding {
  return {
    fingerprint: '',
    category: 'security',
    severity: 'high',
    confidence: 0.9,
    path: 'src/app.ts',
    line: 42,
    title: 'SQL injection',
    detail: 'Unsanitized input',
    evidence: 'db.query(input)',
    suggestion: 'Use parameterized queries',
    ...overrides,
  };
}

function expectedFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256')
    .update(`${category}:${path}:${line}:${title}`)
    .digest('hex')
    .slice(0, 24);
}

describe('SHA256 fingerprint generation', () => {
  it('produces consistent 24-char hex fingerprint', () => {
    const fp = expectedFingerprint('security', 'src/app.ts', 42, 'SQL injection');
    expect(fp).toHaveLength(24);
    expect(fp).toMatch(/^[0-9a-f]{24}$/);
  });

  it('produces different fingerprints for different inputs', () => {
    const fp1 = expectedFingerprint('security', 'src/app.ts', 42, 'SQL injection');
    const fp2 = expectedFingerprint('correctness', 'src/app.ts', 42, 'SQL injection');
    expect(fp1).not.toBe(fp2);
  });

  it('produces same fingerprint for same inputs', () => {
    const fp1 = expectedFingerprint('security', 'src/app.ts', 42, 'SQL injection');
    const fp2 = expectedFingerprint('security', 'src/app.ts', 42, 'SQL injection');
    expect(fp1).toBe(fp2);
  });
});

describe('applyDeterministicPublishAdapter deduplication', () => {
  it('dedupes findings with identical fingerprints keeping higher rank', async () => {
    const finding1 = makeFinding({ severity: 'low', confidence: 0.5, fingerprint: 'dup-fp' });
    const finding2 = makeFinding({ severity: 'high', confidence: 0.9, fingerprint: 'dup-fp' });

    const store = {
      getRunDetails: async () => ({ findings: [], comments: [] }),
      addFindings: async () => {},
      addCommentRecord: async () => {},
    } as any;

    const result = await applyDeterministicPublishAdapter({
      store,
      runId: 'test-run',
      submission: { summaryMarkdown: 'test', findings: [finding1, finding2] },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('dedupes findings with same path/line/title (similarity key)', async () => {
    const finding1 = makeFinding({
      path: 'a.ts',
      line: 10,
      title: 'Bug',
      severity: 'medium',
      fingerprint: 'fp1',
    });
    const finding2 = makeFinding({
      path: 'a.ts',
      line: 10,
      title: 'Bug',
      severity: 'high',
      fingerprint: 'fp2',
    });

    const store = {
      getRunDetails: async () => ({ findings: [], comments: [] }),
      addFindings: async () => {},
      addCommentRecord: async () => {},
    } as any;

    const result = await applyDeterministicPublishAdapter({
      store,
      runId: 'test-run',
      submission: { summaryMarkdown: 'test', findings: [finding1, finding2] },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('fingerprint migration: legacy colon-format matches new JSON tuple format', () => {
    const category = 'security';
    const path = 'src/auth.ts';
    const line = 42;
    const title = 'SQL injection';
    const legacy = createHash('sha256')
      .update(`${category}:${path}:${line}:${title}`)
      .digest('hex')
      .slice(0, 24);
    const modern = createHash('sha256')
      .update(JSON.stringify([category, path, line, title]))
      .digest('hex')
      .slice(0, 24);
    expect(legacy).not.toBe(modern);
  });

  it('preserves published=true when migrating from legacy to modern fingerprint', async () => {
    const legacy = createHash('sha256')
      .update('security:src/auth.ts:42:SQL injection')
      .digest('hex')
      .slice(0, 24);

    const store = {
      getRunDetails: async () => ({
        findings: [
          {
            id: 'old-1',
            runId: 'run-migrate',
            category: 'security',
            severity: 'high',
            path: 'src/auth.ts',
            line: 42,
            title: 'SQL injection',
            detail: 'Use parameterized queries.',
            evidence: '',
            suggestion: '',
            confidence: 0.9,
            fingerprint: legacy,
            published: true,
          },
        ],
        comments: [],
      }),
      addFindings: async () => {},
      addCommentRecord: async () => {},
    } as any;

    const result = await applyDeterministicPublishAdapter({
      store,
      runId: 'run-migrate',
      submission: {
        summaryMarkdown: 'Found SQL injection.',
        findings: [
          {
            category: 'security',
            severity: 'high',
            path: 'src/auth.ts',
            line: 42,
            title: 'SQL injection',
            detail: 'Use parameterized queries.',
            evidence: '',
            suggestion: '',
            confidence: 0.9,
            fingerprint: '',
          },
        ],
      },
    });
    expect(result.findings[0].published).toBe(true);
  });
});
