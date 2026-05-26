import { describe, expect, test } from 'bun:test';
import type { ReviewContext } from '../../../review/types';
import { type ReviewToolState, createReviewTaskTools, normalizeSubmission } from '../review-tools';

function reviewContext(): ReviewContext {
  return {
    workspacePath: '/workspace',
    mirrorPath: '/mirror',
    diff: 'diff --git a/src/app.ts b/src/app.ts',
    changedFiles: [{ path: 'src/app.ts', status: 'M', additions: 2, deletions: 1 }],
    parsedDiff: [
      {
        path: 'src/app.ts',
        changes: [
          { lineNumber: 1, content: '+export function risky() {', type: 'add' },
          { lineNumber: 2, content: '+  return token;', type: 'add' },
        ],
      },
    ],
    fileContents: {
      'src/app.ts': 'export function risky() {\n  return token;\n}\nrisky();',
      'src/other.ts': 'const token = risky();',
    },
  };
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  state: ReviewToolState = { submittedReview: null }
) {
  const tool = createReviewTaskTools({ reviewContext: reviewContext(), state }).find(
    (candidate) => candidate.definition.name === name
  );
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(input, {
    sessionId: 'session',
    model: 'test-model',
    toolCall: { id: 'tool-call', name, arguments: JSON.stringify(input) },
    turn: 1,
  });
}

describe('review task tools', () => {
  test('exposes all seven tools', () => {
    const tools = createReviewTaskTools({
      reviewContext: reviewContext(),
      state: { submittedReview: null },
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'list_changed_files',
      'get_diff',
      'get_file_patch',
      'read_file',
      'search_code',
      'find_references',
      'submit_review_findings',
    ]);
  });

  test('list_changed_files returns changed files', async () => {
    expect(await runTool('list_changed_files', {})).toEqual({
      changedFiles: [{ path: 'src/app.ts', status: 'M', additions: 2, deletions: 1 }],
    });
  });

  test('get_diff returns full diff', async () => {
    expect(await runTool('get_diff', {})).toEqual({ diff: 'diff --git a/src/app.ts b/src/app.ts' });
  });

  test('get_file_patch returns found patch and missing result', async () => {
    expect(await runTool('get_file_patch', { path: 'src/app.ts' })).toEqual({
      found: true,
      patch: '+export function risky() {\n+  return token;',
    });
    expect(await runTool('get_file_patch', { path: 'missing.ts' })).toEqual({
      found: false,
      patch: '',
    });
  });

  test('read_file returns found content and missing result', async () => {
    expect(await runTool('read_file', { path: 'src/app.ts' })).toEqual({
      found: true,
      path: 'src/app.ts',
      content: 'export function risky() {\n  return token;\n}\nrisky();',
    });
    expect(await runTool('read_file', { path: 'missing.ts' })).toEqual({
      found: false,
      path: 'missing.ts',
      content: '',
    });
  });

  test('search_code returns line substring matches', async () => {
    expect(await runTool('search_code', { query: 'risky', maxResults: 2 })).toEqual({
      matches: [
        { path: 'src/app.ts', line: 1, content: 'export function risky() {' },
        { path: 'src/app.ts', line: 4, content: 'risky();' },
      ],
    });
  });

  test('find_references returns line substring matches', async () => {
    expect(await runTool('find_references', { symbol: 'token', maxResults: 2 })).toEqual({
      matches: [
        { path: 'src/app.ts', line: 2, content: '  return token;' },
        { path: 'src/other.ts', line: 1, content: 'const token = risky();' },
      ],
    });
  });

  test('normalizeSubmission fills defaults and generated fingerprint', () => {
    expect(
      normalizeSubmission({
        summaryMarkdown: 'Summary',
        findings: [
          {
            category: 'maintainability',
            severity: 'medium',
            path: 'src/app.ts',
            line: 2,
            title: 'Extract helper',
            detail: 'The logic is duplicated.',
          },
        ],
      })
    ).toEqual({
      summaryMarkdown: 'Summary',
      findings: [
        {
          category: 'maintainability',
          severity: 'medium',
          path: 'src/app.ts',
          line: 2,
          title: 'Extract helper',
          detail: 'The logic is duplicated.',
          confidence: 0.8,
          evidence: '',
          suggestion: '',
          fingerprint: 'maintainability:src/app.ts:2:Extract helper',
        },
      ],
    });
  });

  test('submit_review_findings stores valid findings', async () => {
    const state: ReviewToolState = { submittedReview: null };
    expect(
      await runTool(
        'submit_review_findings',
        {
          summaryMarkdown: 'Found one issue.',
          findings: [
            {
              category: 'reliability',
              severity: 'high',
              path: 'src/app.ts',
              line: 2,
              title: 'Token may be undefined',
              detail: 'The token is returned without checking initialization.',
            },
          ],
        },
        state
      )
    ).toEqual({ accepted: true });
    expect(state.submittedReview?.summaryMarkdown).toBe('Found one issue.');
    expect(state.submittedReview?.findings[0]).toMatchObject({
      category: 'reliability',
      confidence: 0.8,
      evidence: '',
      suggestion: '',
      fingerprint: 'reliability:src/app.ts:2:Token may be undefined',
    });
  });

  test('submit_review_findings rejects invalid submission without changing state', async () => {
    const state: ReviewToolState = {
      submittedReview: { summaryMarkdown: 'Previous', findings: [] },
    };
    const result = await runTool(
      'submit_review_findings',
      {
        summaryMarkdown: 'Invalid',
        findings: [
          {
            category: 'correctness',
            severity: 'low',
            path: 'src/app.ts',
            line: 1,
            title: 'Valid first item',
            detail: 'This item is valid.',
          },
          {
            category: 'quality',
            severity: 'low',
            path: 'src/app.ts',
            line: 2,
            title: 'Invalid category',
            detail: 'This category is not accepted for task tools.',
          },
        ],
      },
      state
    );

    expect(result).toMatchObject({ accepted: false });
    expect(state.submittedReview).toEqual({ summaryMarkdown: 'Previous', findings: [] });
  });
});
