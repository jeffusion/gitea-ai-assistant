import type { KernelTaskHandler } from '../types';

export class KernelTaskRegistry<TState> {
  private readonly handlers = new Map<string, KernelTaskHandler<TState>>();

  register(handler: KernelTaskHandler<TState>): void {
    this.handlers.set(handler.name, handler);
  }

  get(name: string): KernelTaskHandler<TState> | undefined {
    return this.handlers.get(name);
  }

  getAll(): KernelTaskHandler<TState>[] {
    return [...this.handlers.values()];
  }
}
