import { logger } from '../../utils/logger';
import { KernelHookRegistry } from './kernel-hook-registry';
import type { KernelHookInput, KernelLifecycleResult } from './kernel-hook-types';

export async function runKernelHooks(params: {
  registry: KernelHookRegistry;
  input: KernelHookInput;
}): Promise<KernelLifecycleResult> {
  const hooks = params.registry.get(params.input.event);
  const results = [] as KernelLifecycleResult['results'];
  const additionalContexts: string[] = [];
  let updatedInput: Record<string, unknown> | undefined;
  let blockingReason: string | undefined;

  for (const hook of hooks) {
    try {
      const result = await hook.execute(params.input);
      if (!result) {
        continue;
      }
      results.push(result);
      if (result.additionalContext) {
        additionalContexts.push(result.additionalContext);
      }
      if (result.updatedInput) {
        updatedInput = result.updatedInput;
      }
      if (result.continue === false || result.decision === 'block') {
        blockingReason = result.reason ?? `Execution blocked by hook ${hook.name}`;
        break;
      }
    } catch (error) {
      logger.error('Kernel hook 执行失败', {
        hookName: hook.name,
        event: params.input.event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    results,
    additionalContexts,
    updatedInput,
    blockingReason,
  };
}
