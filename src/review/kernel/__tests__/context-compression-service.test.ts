import { afterEach, describe, expect, test } from 'bun:test';
import { modelRoleRepo } from '../../../db/repositories/model-role-repo';
import { tokenCounter } from '../../context/token-counter';
import type { ReviewContext } from '../../types';
import { ContextCompressionService } from '../context-compression-service';

function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  const fileContents = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `src/file-${index}.ts`,
      `export const value${index} = '${'x'.repeat(3200)}';\n`.repeat(2),
    ])
  );

  return {
    workspacePath: '/tmp/workspace',
    mirrorPath: '/tmp/mirror',
    diff: `diff --git a/file.ts b/file.ts\n${'x'.repeat(420_000)}`,
    changedFiles: Array.from({ length: 12 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'M' as const,
      additions: 200,
      deletions: 10,
    })),
    parsedDiff: [],
    fileContents,
    ...overrides,
  };
}

describe('ContextCompressionService', () => {
  const originalGetByRole = modelRoleRepo.getByRole;
  const originalGetContextWindow = tokenCounter.getContextWindow.bind(tokenCounter);

  afterEach(() => {
    modelRoleRepo.getByRole = originalGetByRole;
    tokenCounter.getContextWindow = originalGetContextWindow;
  });

  test('shouldCompress returns true when context exceeds planner threshold', () => {
    modelRoleRepo.getByRole = () => ({
      role: 'planner',
      provider_id: 'provider-1',
      model: 'gpt-4o',
      updated_at: new Date().toISOString(),
    });
    tokenCounter.getContextWindow = () => 16_000;

    const service = new ContextCompressionService({
      chatForRole: async () => {
        throw new Error('not used');
      },
    } as never);

    expect(service.shouldCompress(makeContext())).toBe(true);
    expect(
      service.shouldCompress(
        makeContext({ diff: 'tiny diff', fileContents: { 'src/file.ts': 'tiny' } })
      )
    ).toBe(false);
  });

  test('compress returns persisted summary payload', async () => {
    modelRoleRepo.getByRole = () => ({
      role: 'planner',
      provider_id: 'provider-1',
      model: 'gpt-4o',
      updated_at: new Date().toISOString(),
    });
    tokenCounter.getContextWindow = () => 128_000;

    const service = new ContextCompressionService({
      chatForRole: async () => ({
        content: JSON.stringify({
          summary:
            '## Change Overview\n- Updated security-sensitive flow\n\n## High-Risk Areas\n- auth\n\n## Important Files\n- src/file.ts\n\n## Open Questions\n- none\n\n## Recommended Focus\n- review security',
        }),
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
    } as never);

    const result = await service.compress(makeContext(), 'Project prompt');

    expect(result.summary).toContain('## Change Overview');
    expect(result.sourceTokenEstimate).toBeGreaterThan(result.summaryTokenEstimate);
    expect(result.triggerThreshold).toBe(Math.floor(128_000 * 0.8));
    expect(result.model).toBe('gpt-4o');
  });
});
