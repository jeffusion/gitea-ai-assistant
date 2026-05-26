import { describe, expect, it } from 'bun:test';
import { buildRepairPrompt, findingResponseSchema, parseFindingResponse } from '../index';

describe('findingResponseSchema', () => {
  it('parses valid findings', () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: 'high',
          confidence: 0.9,
          path: 'src/app.ts',
          line: 42,
          title: 'SQL injection',
          detail: 'Unsanitized input in query',
          evidence: 'db.query(req.params.id)',
          suggestion: 'Use parameterized queries',
          category: 'security',
        },
      ],
    });
    const result = parseFindingResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('high');
      expect(result.findings[0].category).toBe('security');
    }
  });

  it('applies defaults for optional fields', () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: 'low',
          path: 'src/util.ts',
          line: 10,
          title: 'Missing error handling',
          detail: 'No try-catch around async call',
        },
      ],
    });
    const result = parseFindingResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const finding = result.findings[0];
      expect(finding.confidence).toBe(0.8);
      expect(finding.evidence).toBe('');
      expect(finding.suggestion).toBe('');
      expect(finding.category).toBeUndefined();
    }
  });

  it('rejects invalid severity', () => {
    const raw = JSON.stringify({
      findings: [{ severity: 'critical', path: 'a.ts', line: 1, title: 'x', detail: 'y' }],
    });
    const result = parseFindingResponse(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const result = parseFindingResponse('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.raw).toBe('not json');
    }
  });

  it('defaults to empty findings array', () => {
    const result = findingResponseSchema.parse({});
    expect(result.findings).toEqual([]);
  });
});

describe('buildRepairPrompt', () => {
  it('includes the parse error', () => {
    const prompt = buildRepairPrompt('missing field "path"');
    expect(prompt).toContain('missing field "path"');
    expect(prompt).toContain('JSON');
  });
});
