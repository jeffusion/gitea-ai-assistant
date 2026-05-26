import { z } from 'zod';

export type AgentDefinitionSource = 'built-in' | 'project' | 'user' | 'plugin';

export const AGENT_DEFINITION_SOURCES = [
  'built-in',
  'project',
  'user',
  'plugin',
] as const satisfies readonly AgentDefinitionSource[];

export type AgentPermissionMode = 'default' | 'ask' | 'deny';

export const AGENT_PERMISSION_MODES = [
  'default',
  'ask',
  'deny',
] as const satisfies readonly AgentPermissionMode[];

export type AgentIsolation = 'none' | 'workspace' | 'process';

export const AGENT_ISOLATIONS = [
  'none',
  'workspace',
  'process',
] as const satisfies readonly AgentIsolation[];

export interface AgentDefinitionHooks {
  sessionStart?: unknown;
  subagentStart?: unknown;
  permissionRequest?: unknown;
  preToolUse?: unknown;
  postToolUse?: unknown;
  postToolUseFailure?: unknown;
  [key: string]: unknown;
}

const agentDefinitionHooksSchema: z.ZodType<AgentDefinitionHooks> = z
  .object({
    sessionStart: z.unknown().optional(),
    subagentStart: z.unknown().optional(),
    permissionRequest: z.unknown().optional(),
    preToolUse: z.unknown().optional(),
    postToolUse: z.unknown().optional(),
    postToolUseFailure: z.unknown().optional(),
  })
  .catchall(z.unknown());

export const agentDefinitionSchema = z
  .object({
    agentType: z.string().min(1),
    name: z.string().min(1),
    whenToUse: z.string().min(1),
    source: z.enum(AGENT_DEFINITION_SOURCES),
    tools: z.array(z.string()).default([]),
    disallowedTools: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    hooks: agentDefinitionHooksSchema.default({}),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().default(1),
    permissionMode: z.enum(AGENT_PERMISSION_MODES).default('default'),
    background: z.boolean().default(false),
    isolation: z.enum(AGENT_ISOLATIONS).default('none'),
    getSystemPrompt: z
      .custom<() => string>((value) => typeof value === 'function', {
        message: 'getSystemPrompt must be a function',
      })
      .optional(),
  })
  .strip();

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export function normalizeAgentDefinition(definition: unknown): AgentDefinition {
  return agentDefinitionSchema.parse(definition);
}

export function isAgentDefinition(definition: unknown): definition is AgentDefinition {
  return agentDefinitionSchema.safeParse(definition).success;
}

export function parseAgentDefinition(definition: unknown): AgentDefinition {
  return normalizeAgentDefinition(definition);
}
