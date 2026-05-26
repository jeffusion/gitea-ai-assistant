import { z } from 'zod';

const findingItemSchema = z.object({
  category: z.enum(['correctness', 'security', 'reliability', 'maintainability']).optional(),
  severity: z.enum(['high', 'medium', 'low']),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  path: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence: z.string().optional().default(''),
  suggestion: z.string().optional().default(''),
  fingerprint: z.string().min(1).optional(),
});

export const findingResponseSchema = z.object({
  findings: z.array(findingItemSchema).default([]),
});

export type FindingResponse = z.infer<typeof findingResponseSchema>;
export type FindingItem = z.infer<typeof findingItemSchema>;

export interface FindingParseResult {
  ok: true;
  findings: FindingItem[];
}

export interface FindingParseError {
  ok: false;
  error: string;
  raw: string;
}

export type FindingParseOutcome = FindingParseResult | FindingParseError;

/**
 * Parse raw LLM output text into validated findings.
 * Returns a discriminated union: { ok: true, findings } or { ok: false, error, raw }.
 */
export function parseFindingResponse(raw: string): FindingParseOutcome {
  try {
    const parsed = JSON.parse(raw);
    const result = findingResponseSchema.parse(parsed);
    return { ok: true, findings: result.findings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, raw };
  }
}

/**
 * Build a repair prompt to ask the LLM to fix its malformed JSON output.
 * Returns null if no more repair attempts should be made.
 */
export function buildRepairPrompt(parseError: string): string {
  return `上一次最终结果无法通过 findingResponseSchema 校验。校验错误: ${parseError}\n\n请输出严格 JSON，格式如下：\n{"findings":[{"severity":"high|medium|low","confidence":0.8,"path":"...","line":1,"title":"...","detail":"...","evidence":"...","suggestion":"...","category":"correctness|security|reliability|maintainability"}]}\n\n不要输出额外文字，只输出 JSON。`;
}
