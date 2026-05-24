import { z } from 'zod';

const findingItemSchema = z.object({
  category: z.enum(['correctness', 'security', 'quality']).optional(),
  severity: z.enum(['high', 'medium', 'low']),
  confidence: z.number().min(0).max(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence: z.string().min(1),
  suggestion: z.string().min(1),
  fingerprint: z.string().min(1).optional(),
});

export const findingResponseSchema = z.object({
  findings: z.array(findingItemSchema).default([]),
});

export type FindingResponse = z.infer<typeof findingResponseSchema>;
