import { describe, expect, test } from 'bun:test';

import { resolveAgentModel } from '../model-resolver';

describe('resolveAgentModel', () => {
  test('uses spawn override before every configured fallback', () => {
    const model = resolveAgentModel({
      spawnOverride: 'spawn-model',
      agentDefinition: { model: 'definition-model' },
      defaultSubagentModel: 'subagent-default-model',
      mainAgentModel: 'main-model',
    });

    expect(model).toBe('spawn-model');
  });

  test('falls back to AgentDefinition.model when spawn override is missing', () => {
    const model = resolveAgentModel({
      agentDefinition: { model: 'definition-model' },
      defaultSubagentModel: 'subagent-default-model',
      mainAgentModel: 'main-model',
    });

    expect(model).toBe('definition-model');
  });

  test('falls back to defaultSubagentModel when AgentDefinition.model is missing', () => {
    const model = resolveAgentModel({
      agentDefinition: {},
      defaultSubagentModel: 'subagent-default-model',
      mainAgentModel: 'main-model',
    });

    expect(model).toBe('subagent-default-model');
  });

  test('falls back to mainAgentModel when no subagent-specific model exists', () => {
    const model = resolveAgentModel({
      agentDefinition: {},
      mainAgentModel: 'main-model',
    });

    expect(model).toBe('main-model');
  });
});
