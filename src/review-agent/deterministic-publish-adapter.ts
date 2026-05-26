import { createHash, randomUUID } from 'node:crypto';
import { applyPublishPolicy } from '../review/policy/publish-policy';
import type { FileReviewStore } from '../review/store/file-review-store';
import type { Finding, ReviewCommentRecord } from '../review/types';
import type { ReviewAgentFinding, SubmittedReviewFindings } from './tools';

interface PublishIntent {
  path?: string;
  line?: number;
  body: string;
  fingerprint?: string;
}

export interface DeterministicPublishResult {
  findings: Finding[];
  summaryBody: string;
  lineIntents: PublishIntent[];
}

function severityWeight(severity: Finding['severity']): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function rankFinding(finding: ReviewAgentFinding): number {
  return severityWeight(finding.severity) * 1000 + Math.round(finding.confidence * 100);
}

function buildFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256')
    .update(JSON.stringify([category, path, line, title]))
    .digest('hex')
    .slice(0, 24);
}

function buildLegacyFingerprint(
  category: string,
  path: string,
  line: number,
  title: string
): string {
  return createHash('sha256')
    .update(`${category}:${path}:${line}:${title}`)
    .digest('hex')
    .slice(0, 24);
}

function normalizeTitleRoot(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityKey(finding: ReviewAgentFinding): string {
  return `${finding.path}:${finding.line}:${normalizeTitleRoot(finding.title)}`;
}

function dedupeFindings(candidates: ReviewAgentFinding[]): ReviewAgentFinding[] {
  const ensured = candidates.map((f) =>
    f.fingerprint ? f : { ...f, fingerprint: buildFingerprint(f.category, f.path, f.line, f.title) }
  );
  const byFingerprint = new Map<string, ReviewAgentFinding>();
  for (const finding of ensured) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing || rankFinding(finding) > rankFinding(existing)) {
      byFingerprint.set(finding.fingerprint, finding);
    }
  }

  const bySimilarity = new Map<string, ReviewAgentFinding>();
  for (const finding of byFingerprint.values()) {
    const key = similarityKey(finding);
    const existing = bySimilarity.get(key);
    if (!existing || rankFinding(finding) > rankFinding(existing)) {
      bySimilarity.set(key, finding);
    }
  }

  return [...bySimilarity.values()].sort((a, b) => rankFinding(b) - rankFinding(a));
}

function findingToLineComment(finding: ReviewAgentFinding): string {
  return `**[${finding.severity.toUpperCase()}][${finding.category}]** ${finding.title}\n\n${finding.detail}\n\n建议: ${finding.suggestion}`;
}

function countBySeverity(
  findings: ReviewAgentFinding[]
): Record<'high' | 'medium' | 'low', number> {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function buildSummaryBody(summaryMarkdown: string, findings: ReviewAgentFinding[]): string {
  const trimmed = summaryMarkdown.trim();
  const counts = countBySeverity(findings);
  const stats = `发现 ${findings.length} 个问题（high ${counts.high} / medium ${counts.medium} / low ${counts.low}）`;

  if (!trimmed) {
    const fallback = findings.length
      ? findings
          .slice(0, 5)
          .map((f) => `- [${f.severity}] ${f.path}:${f.line} ${f.title}`)
          .join('\n')
      : '- 未发现需要处理的问题。';
    return `## AI Agent代码审查结果\n\n${stats}\n\n${fallback}`;
  }

  return `## AI Agent代码审查结果\n\n${trimmed}\n\n${stats}`;
}

function intentKey(intent: PublishIntent): string {
  return `${intent.path ?? ''}:${intent.line ?? 0}:${intent.fingerprint ?? ''}:${intent.body}`;
}

function existingIntentKeys(comments: ReviewCommentRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const comment of comments) {
    keys.add(
      intentKey({
        path: comment.path,
        line: comment.line,
        fingerprint: comment.fingerprint,
        body: comment.body,
      })
    );
  }
  return keys;
}

export async function applyDeterministicPublishAdapter(params: {
  store: FileReviewStore;
  runId: string;
  submission: SubmittedReviewFindings;
}): Promise<DeterministicPublishResult> {
  const normalized = dedupeFindings(params.submission.findings);
  const details = await params.store.getRunDetails(params.runId);
  const existingPublished = new Map<string, boolean>();
  for (const finding of details?.findings ?? []) {
    existingPublished.set(finding.fingerprint, finding.published);
    const legacy = buildLegacyFingerprint(
      finding.category,
      finding.path,
      finding.line,
      finding.title
    );
    if (legacy !== finding.fingerprint) {
      existingPublished.set(legacy, finding.published);
    }
  }

  const findings: Finding[] = normalized.map((finding) => ({
    ...finding,
    id: randomUUID(),
    runId: params.runId,
    published: existingPublished.get(finding.fingerprint) ?? false,
  }));
  await params.store.addFindings(params.runId, findings);

  const summaryBody = buildSummaryBody(params.submission.summaryMarkdown, normalized);
  const lineEligible = applyPublishPolicy(normalized).publishable;
  const lineIntents: PublishIntent[] = lineEligible.map((finding) => ({
    path: finding.path,
    line: finding.line,
    body: findingToLineComment(finding),
    fingerprint: finding.fingerprint,
  }));

  const intents: PublishIntent[] = [{ body: summaryBody }, ...lineIntents];
  const existingKeys = existingIntentKeys(details?.comments ?? []);
  for (const intent of intents) {
    if (existingKeys.has(intentKey(intent))) continue;
    await params.store.addCommentRecord({
      runId: params.runId,
      path: intent.path,
      line: intent.line,
      body: intent.body,
      status: 'pending',
      fingerprint: intent.fingerprint,
    });
  }

  return {
    findings,
    summaryBody,
    lineIntents,
  };
}
