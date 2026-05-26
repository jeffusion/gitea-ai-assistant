import type { AgentDefinition, AgentIsolation, AgentRegistry } from '../definitions';
import type { MainAgentTool, MainAgentToolContext } from '../loop';
import { resolveAgentModel } from '../model';

export interface SpawnSubagentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: string;
  run_in_background?: boolean;
  isolation?: AgentIsolation;
  cwd?: string;
}

export interface SpawnSubagentExecutionInput {
  agentDefinition: AgentDefinition;
  agentType: string;
  model: string;
  description: string;
  prompt: string;
  isolation?: AgentIsolation;
  cwd?: string;
  parent: MainAgentToolContext;
}

export interface SpawnSubagentExecutor {
  execute(input: SpawnSubagentExecutionInput): Promise<unknown> | unknown;
}

export interface SpawnSubagentToolOptions {
  agentRegistry: AgentRegistry;
  executor: SpawnSubagentExecutor;
  defaultSubagentModel?: string;
}

type SpawnSubagentToolResult =
  | {
      status: 'completed';
      agentType: string;
      model: string;
      description: string;
      result: unknown;
      summary?: unknown;
    }
  | {
      status: 'error';
      code: string;
      message: string;
      requestedType?: string;
      availableTypes?: string[];
      issues?: string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseInput(
  argumentsValue: unknown
): { ok: true; value: SpawnSubagentInput } | { ok: false; issues: string[] } {
  if (!isRecord(argumentsValue)) {
    return { ok: false, issues: ['arguments must be an object'] };
  }

  const issues: string[] = [];
  const description = optionalString(argumentsValue.description);
  const prompt = optionalString(argumentsValue.prompt);

  if (!description) issues.push('description is required');
  if (!prompt) issues.push('prompt is required');

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      description: description as string,
      prompt: prompt as string,
      subagent_type: optionalString(argumentsValue.subagent_type),
      model: optionalString(argumentsValue.model),
      run_in_background:
        typeof argumentsValue.run_in_background === 'boolean'
          ? argumentsValue.run_in_background
          : undefined,
      isolation: optionalString(argumentsValue.isolation) as AgentIsolation | undefined,
      cwd: optionalString(argumentsValue.cwd),
    },
  };
}

function availableTypes(registry: AgentRegistry): string[] {
  return registry.activeAgents.map((agent) => agent.agentType).sort();
}

function resolveAgentType(
  input: SpawnSubagentInput,
  registry: AgentRegistry
): AgentDefinition | undefined {
  const requestedType = input.subagent_type ?? 'general-purpose';
  return registry.getActiveAgent(requestedType);
}

function extractSummary(result: unknown): unknown {
  if (isRecord(result) && 'summary' in result) return result.summary;
  return undefined;
}

export function createSpawnSubagentTool(options: SpawnSubagentToolOptions): MainAgentTool {
  return {
    definition: {
      name: 'spawn_subagent',
      description:
        'Spawn a registered subagent with an explicit prompt and return its structured result.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          prompt: { type: 'string' },
          subagent_type: { type: 'string' },
          model: { type: 'string' },
          run_in_background: { type: 'boolean' },
          isolation: { type: 'string', enum: ['none', 'workspace', 'process'] },
          cwd: { type: 'string' },
        },
        required: ['description', 'prompt'],
      },
    },
    async execute(argumentsValue, context): Promise<SpawnSubagentToolResult> {
      const parsed = parseInput(argumentsValue);
      if (!parsed.ok) {
        return {
          status: 'error',
          code: 'invalid_arguments',
          message: 'spawn_subagent requires non-empty description and prompt arguments.',
          issues: parsed.issues,
        };
      }

      const input = parsed.value;
      const requestedType = input.subagent_type ?? 'general-purpose';
      const agentDefinition = resolveAgentType(input, options.agentRegistry);
      if (!agentDefinition) {
        return {
          status: 'error',
          code: 'unknown_subagent_type',
          message: `Subagent type '${requestedType}' is not active.`,
          requestedType,
          availableTypes: availableTypes(options.agentRegistry),
        };
      }

      const model = resolveAgentModel({
        spawnOverride: input.model,
        agentDefinition,
        defaultSubagentModel: options.defaultSubagentModel,
        mainAgentModel: context.model,
      });

      if (input.run_in_background) {
        return {
          status: 'error',
          code: 'background_execution_unsupported',
          message:
            'spawn_subagent background execution is not supported until the isolated SubagentRunner is implemented.',
          requestedType: agentDefinition.agentType,
          availableTypes: availableTypes(options.agentRegistry),
        };
      }

      const result = await options.executor.execute({
        agentDefinition,
        agentType: agentDefinition.agentType,
        model,
        description: input.description,
        prompt: input.prompt,
        isolation: input.isolation ?? agentDefinition.isolation,
        cwd: input.cwd,
        parent: context,
      });

      return {
        status: 'completed',
        agentType: agentDefinition.agentType,
        model,
        description: input.description,
        result,
        summary: extractSummary(result),
      };
    },
  };
}
