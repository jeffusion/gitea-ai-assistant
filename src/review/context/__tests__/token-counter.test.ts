// @ts-ignore bun:test is provided by Bun at runtime
declare module 'bun:test' {
  // @ts-ignore bun:test types may already exist
  export const describe: any;
  // @ts-ignore bun:test types may already exist
  export const test: any;
  // @ts-ignore bun:test types may already exist
  export const expect: any;
}

// @ts-ignore bun:test is provided by Bun at runtime
import { describe, expect, test } from 'bun:test';

import { TokenCounter, tokenCounter } from '../token-counter';

describe('TokenCounter.count', () => {
  test('returns 0 for empty string', () => {
    const counter = new TokenCounter();
    expect(counter.count('')).toBe(0);
  });

  test('uses ceil(length / 3.5) for known string', () => {
    const counter = new TokenCounter();
    expect(counter.count('hello')).toBe(2);
  });

  test('handles longer text using same formula', () => {
    const counter = new TokenCounter();
    const text = 'a'.repeat(36);
    expect(counter.count(text)).toBe(Math.ceil(36 / 3.5));
  });
});

describe('TokenCounter.clip', () => {
  test('returns text as-is when within budget', () => {
    const counter = new TokenCounter();
    const text = 'short text';
    expect(counter.clip(text, 100)).toBe(text);
  });

  test('truncates with message when exceeding budget', () => {
    const counter = new TokenCounter();
    const maxTokens = 4;
    const maxChars = Math.floor(maxTokens * 3.5);
    const text = 'abcdefghijklmnopqrstuvwxyz';

    const clipped = counter.clip(text, maxTokens);

    expect(clipped.startsWith(text.slice(0, maxChars))).toBe(true);
    expect(clipped).toContain('[truncated, exceeded 4 token budget]');
    expect(clipped).toBe(`${text.slice(0, maxChars)}\n... [truncated, exceeded 4 token budget]`);
  });
});

describe('TokenCounter.getContextWindow', () => {
  test('returns known context window for gpt-4o', () => {
    const counter = new TokenCounter();
    expect(counter.getContextWindow('gpt-4o')).toBe(128000);
  });

  test('returns known context window for claude-sonnet-4-20250514', () => {
    const counter = new TokenCounter();
    expect(counter.getContextWindow('claude-sonnet-4-20250514')).toBe(200000);
  });

  test('returns default context window for versioned model not in registry', () => {
    const counter = new TokenCounter();
    // tokenlens static registry may not have dated variants — falls back to default
    expect(counter.getContextWindow('gpt-4o-2024-08-06')).toBe(128000);
  });

  test('returns default context window for unknown models', () => {
    const counter = new TokenCounter();
    expect(counter.getContextWindow('unknown-model-xyz')).toBe(128000);
  });
});

describe('TokenCounter.getUsableBudget', () => {
  test('returns contextWindow - 4000 for known model', () => {
    const counter = new TokenCounter();
    expect(counter.getUsableBudget('gpt-4o')).toBe(124000);
  });

  test('never returns less than 1000 for tiny context window', () => {
    class TinyWindowTokenCounter extends TokenCounter {
      getContextWindow(_model: string): number {
        return 500;
      }
    }

    const counter = new TinyWindowTokenCounter();
    expect(counter.getUsableBudget('tiny-model')).toBe(1000);
  });
});

describe('TokenCounter exports and constructor options', () => {
  test('exports singleton tokenCounter instance', () => {
    expect(tokenCounter).toBeInstanceOf(TokenCounter);
  });

  test('supports custom charsPerToken in constructor', () => {
    const counter = new TokenCounter(2);
    expect(counter.count('hello')).toBe(3);
  });
});

describe('TokenCounter dynamic catalog', () => {
  test('hasCatalog is false before refreshCatalog', () => {
    const counter = new TokenCounter();
    expect(counter.hasCatalog).toBe(false);
  });

  test('getContextWindow works without catalog (static fallback)', () => {
    const counter = new TokenCounter();
    // Should use static tokenlens data, not crash
    expect(counter.getContextWindow('gpt-4o')).toBe(128000);
  });

  test('stopRefresh is safe to call without active timer', () => {
    const counter = new TokenCounter();
    // Should not throw
    counter.stopRefresh();
  });

  test('clip respects newline boundary when possible', () => {
    const counter = new TokenCounter();
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const text = lines.join('\n');
    const budget = 3;
    const clipped = counter.clip(text, budget);
    expect(clipped).toContain('... [truncated');
    expect(clipped.includes('\n')).toBe(true);
  });

  test('clip falls back to char boundary when no newline near cutoff', () => {
    const counter = new TokenCounter();
    const text = 'abcdefghij';
    const clipped = counter.clip(text, 2);
    expect(clipped).toContain('... [truncated');
  });
});
