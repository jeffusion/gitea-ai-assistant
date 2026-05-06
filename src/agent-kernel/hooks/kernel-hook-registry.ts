import type { KernelHookDefinition, KernelHookEventName } from './kernel-hook-types';

export class KernelHookRegistry {
  private readonly hooks = new Map<KernelHookEventName, KernelHookDefinition[]>();

  register(hook: KernelHookDefinition): void {
    const existing = this.hooks.get(hook.event) ?? [];
    existing.push(hook);
    this.hooks.set(hook.event, existing);
  }

  get(event: KernelHookEventName): KernelHookDefinition[] {
    return this.hooks.get(event) ?? [];
  }

  getAll(): KernelHookDefinition[] {
    return [...this.hooks.values()].flat();
  }
}
