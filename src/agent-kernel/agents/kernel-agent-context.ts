import { AsyncLocalStorage } from 'node:async_hooks';
import type { KernelSubagentContextRecord } from '../types';

const kernelAgentContextStorage = new AsyncLocalStorage<KernelSubagentContextRecord>();

export function getKernelAgentContext(): KernelSubagentContextRecord | undefined {
  return kernelAgentContextStorage.getStore();
}

export function runWithKernelAgentContext<T>(
  context: KernelSubagentContextRecord,
  fn: () => Promise<T>
): Promise<T> {
  return kernelAgentContextStorage.run(context, fn);
}
