import { createHash } from 'node:crypto';
import type { MainAgentTool } from '../../agent-kernel/loop/types';
import type { Finding, ReviewContext } from '../../review/types';
import type { FindingItem } from '../schema';
import { parseFindingResponse } from '../schema';

export type ReviewAgentFinding = Omit<Finding, 'id' | 'runId' | 'published'>;

export interface SubmittedReviewFindings {
  summaryMarkdown: string;
  findings: ReviewAgentFinding[];
}

export interface ReviewToolState {
  submittedReview: SubmittedReviewFindings | null;
}

export interface CreateReviewTaskToolsOptions {
  reviewContext: ReviewContext;
  state: ReviewToolState;
}

interface LineMatch {
  path: string;
  line: number;
  content: string;
}

function toolParameters(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function buildFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256')
    .update(JSON.stringify([category, path, line, title]))
    .digest('hex')
    .slice(0, 24);
}

function findingItemToReviewAgent(item: FindingItem): ReviewAgentFinding {
  const category = item.category ?? 'correctness';
  return {
    fingerprint: item.fingerprint || buildFingerprint(category, item.path, item.line, item.title),
    category,
    severity: item.severity,
    confidence: item.confidence ?? 0.8,
    path: item.path,
    line: item.line,
    title: item.title,
    detail: item.detail,
    evidence: item.evidence ?? '',
    suggestion: item.suggestion ?? '',
  };
}

/** Parse raw JSON text into validated SubmittedReviewFindings using Zod schema. */
export function parseSubmissionFromText(raw: string): SubmittedReviewFindings | null {
  const outcome = parseFindingResponse(raw);
  if (!outcome.ok) return null;
  return {
    summaryMarkdown: '',
    findings: outcome.findings.map(findingItemToReviewAgent),
  };
}

function normalizeFinding(value: unknown): ReviewAgentFinding {
  const outcome = parseFindingResponse(JSON.stringify({ findings: [value] }));
  if (outcome.ok && outcome.findings.length > 0) {
    return findingItemToReviewAgent(outcome.findings[0]);
  }
  const detail = !outcome.ok ? outcome.error : 'no valid findings in response';
  throw new Error(`Finding validation failed: ${detail}`);
}

export function normalizeSubmission(value: unknown): SubmittedReviewFindings {
  const input = requireObject(value, 'Submission must be an object');
  const summaryMarkdown = readString(input, 'summaryMarkdown');
  if (summaryMarkdown === undefined) throw new Error('summaryMarkdown must be a string');
  if (!Array.isArray(input.findings)) throw new Error('findings must be an array');

  return {
    summaryMarkdown,
    findings: input.findings.map((finding) => normalizeFinding(finding)),
  };
}

function lineSubstringMatches(
  fileContents: Record<string, string>,
  query: string,
  maxResults: number
): LineMatch[] {
  if (!query) return [];

  const matches: LineMatch[] = [];
  for (const [path, content] of Object.entries(fileContents)) {
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) continue;
      matches.push({ path, line: index + 1, content: lines[index] });
      if (matches.length >= maxResults) return matches;
    }
  }

  return matches;
}

function filePatch(reviewContext: ReviewContext, path: string): string | null {
  const parsed = reviewContext.parsedDiff.find((file) => file.path === path);
  if (!parsed) return null;
  return parsed.changes.map((change) => change.content).join('\n');
}

function maxResults(input: Record<string, unknown>): number {
  return Math.max(1, Math.floor(readNumber(input, 'maxResults') ?? 20));
}

function toolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function reviewTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown
): MainAgentTool {
  return {
    definition: {
      name,
      description,
      parameters: toolParameters(properties, required),
    },
    execute: (input) => execute(toolInput(input)),
  };
}

export function createReviewTaskTools(options: CreateReviewTaskToolsOptions): MainAgentTool[] {
  const { reviewContext, state } = options;

  return [
    reviewTool(
      'list_changed_files',
      'List files changed in the review context.',
      {},
      [],
      async () => ({
        changedFiles: reviewContext.changedFiles,
      })
    ),
    reviewTool(
      'get_diff',
      'Return the complete diff for the review context.',
      {},
      [],
      async () => ({
        diff: reviewContext.diff,
      })
    ),
    reviewTool(
      'get_file_patch',
      'Return the parsed patch for one changed file.',
      { path: { type: 'string' } },
      ['path'],
      async (input) => {
        const path = readString(input, 'path') ?? '';
        const patch = filePatch(reviewContext, path);
        return { found: patch !== null, patch: patch ?? '' };
      }
    ),
    reviewTool(
      'read_file',
      'Read a file from the review context snapshot.',
      { path: { type: 'string' } },
      ['path'],
      async (input) => {
        const path = readString(input, 'path') ?? '';
        const content = reviewContext.fileContents[path];
        return { found: content !== undefined, path, content: content ?? '' };
      }
    ),
    reviewTool(
      'search_code',
      'Search review file contents with a line substring match.',
      { query: { type: 'string' }, maxResults: { type: 'number' } },
      ['query'],
      async (input) => ({
        matches: lineSubstringMatches(
          reviewContext.fileContents,
          readString(input, 'query') ?? '',
          maxResults(input)
        ),
      })
    ),
    reviewTool(
      'find_references',
      'Find references to a symbol with a line substring match.',
      { symbol: { type: 'string' }, maxResults: { type: 'number' } },
      ['symbol'],
      async (input) => ({
        matches: lineSubstringMatches(
          reviewContext.fileContents,
          readString(input, 'symbol') ?? '',
          maxResults(input)
        ),
      })
    ),
    reviewTool(
      'submit_review_findings',
      'Submit the final review summary and validated findings.',
      {
        summaryMarkdown: { type: 'string' },
        findings: { type: 'array', items: { type: 'object' } },
      },
      ['summaryMarkdown', 'findings'],
      async (input) => {
        try {
          const submittedReview = normalizeSubmission(input);
          state.submittedReview = submittedReview;
          return { accepted: true };
        } catch (error) {
          return {
            accepted: false,
            error: error instanceof Error ? error.message : 'Invalid submission',
          };
        }
      }
    ),
  ];
}
