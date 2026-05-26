import { Hono } from 'hono';
import {
  type AgentDefinition,
  type AgentDefinitionLoadError,
  loadAgentRegistry,
} from '../agent-kernel/definitions';
import { configManager } from '../config/config-manager';

export const agentsRouter = new Hono();

interface SerializableAgentDefinition {
  agentType: string;
  name: string;
  whenToUse: string;
  source: AgentDefinition['source'];
  tools: string[];
  disallowedTools: string[];
  skills: string[];
  model?: string;
  maxTurns: number;
  permissionMode: AgentDefinition['permissionMode'];
  background: boolean;
  isolation: AgentDefinition['isolation'];
}

interface SerializableLoadError {
  source: AgentDefinitionLoadError['source'];
  filePath: string;
  code: AgentDefinitionLoadError['code'];
  message: string;
  issues?: string[];
}

function toSerializableDefinition(definition: AgentDefinition): SerializableAgentDefinition {
  return {
    agentType: definition.agentType,
    name: definition.name,
    whenToUse: definition.whenToUse,
    source: definition.source,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    skills: definition.skills,
    model: definition.model,
    maxTurns: definition.maxTurns,
    permissionMode: definition.permissionMode,
    background: definition.background,
    isolation: definition.isolation,
  };
}

function toSerializableLoadError(error: AgentDefinitionLoadError): SerializableLoadError {
  return {
    source: error.source,
    filePath: error.filePath,
    code: error.code,
    message: error.message,
    issues: error.issues,
  };
}

agentsRouter.get('/definitions', async (c) => {
  const registry = await loadAgentRegistry({ projectRoot: process.cwd() });

  return c.json({
    activeDefinitions: registry.activeAgents.map(toSerializableDefinition),
    allDefinitions: registry.allAgents.map(toSerializableDefinition),
    loadErrors: registry.failedFiles.map(toSerializableLoadError),
  });
});

agentsRouter.get('/model-config', (c) => {
  const current = configManager.getCurrent();

  return c.json({
    agentMainModel: current.review.agentMainModel,
    agentDefaultSubagentModel: current.review.agentDefaultSubagentModel,
    source: {
      agentMainModel: configManager.getSource('AGENT_MAIN_MODEL'),
      agentDefaultSubagentModel: configManager.getSource('AGENT_DEFAULT_SUBAGENT_MODEL'),
    },
  });
});

agentsRouter.put('/model-config', async (c) => {
  const body = await c.req.json<{
    agentMainModel?: unknown;
    agentDefaultSubagentModel?: unknown;
  }>();

  const updates: Record<string, string> = {};

  if (body.agentMainModel !== undefined) {
    if (typeof body.agentMainModel !== 'string' || !body.agentMainModel.trim()) {
      return c.json({ message: 'agentMainModel must be a non-empty string' }, 400);
    }
    updates.AGENT_MAIN_MODEL = body.agentMainModel.trim();
  }

  if (body.agentDefaultSubagentModel !== undefined) {
    if (
      typeof body.agentDefaultSubagentModel !== 'string' ||
      !body.agentDefaultSubagentModel.trim()
    ) {
      return c.json({ message: 'agentDefaultSubagentModel must be a non-empty string' }, 400);
    }
    updates.AGENT_DEFAULT_SUBAGENT_MODEL = body.agentDefaultSubagentModel.trim();
  }

  if (Object.keys(updates).length === 0) {
    return c.json(
      {
        message: 'At least one of agentMainModel or agentDefaultSubagentModel is required',
      },
      400
    );
  }

  await configManager.setOverrides(updates);
  const current = configManager.getCurrent();

  return c.json({
    agentMainModel: current.review.agentMainModel,
    agentDefaultSubagentModel: current.review.agentDefaultSubagentModel,
    source: {
      agentMainModel: configManager.getSource('AGENT_MAIN_MODEL'),
      agentDefaultSubagentModel: configManager.getSource('AGENT_DEFAULT_SUBAGENT_MODEL'),
    },
  });
});
