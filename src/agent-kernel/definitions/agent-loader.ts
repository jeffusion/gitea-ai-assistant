import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { AgentDefinition, AgentDefinitionSource } from './agent-definition';
import { normalizeAgentDefinition } from './agent-definition';

export const PROJECT_AGENT_DEFINITIONS_DIR = '.gitea-assistant/agents';

export type AgentDefinitionLoadErrorCode =
  | 'missing_frontmatter'
  | 'malformed_frontmatter'
  | 'empty_body'
  | 'invalid_definition'
  | 'read_error';

export interface AgentDefinitionLoadError {
  source: AgentDefinitionSource;
  filePath: string;
  code: AgentDefinitionLoadErrorCode;
  message: string;
  issues?: string[];
}

export interface AgentDefinitionLoadResult {
  definitions: AgentDefinition[];
  failedFiles: AgentDefinitionLoadError[];
}

interface MarkdownParseOptions {
  source: AgentDefinitionSource;
  filePath: string;
}

type FrontmatterRecord = Record<string, string | number | boolean | string[]>;

export function parseAgentDefinitionMarkdown(
  content: string,
  options: MarkdownParseOptions
): AgentDefinition | AgentDefinitionLoadError {
  const extracted = extractFrontmatter(content, options);
  if (isLoadError(extracted)) {
    return extracted;
  }

  const systemPrompt = extracted.body.trim();
  if (!systemPrompt) {
    return {
      source: options.source,
      filePath: options.filePath,
      code: 'empty_body',
      message: 'Agent definition markdown body must contain the system prompt.',
    };
  }

  const frontmatter = parseFrontmatter(extracted.frontmatter, options);
  if (isLoadError(frontmatter)) {
    return frontmatter;
  }

  try {
    return normalizeAgentDefinition({
      ...frontmatter,
      source: options.source,
      getSystemPrompt: () => systemPrompt,
    });
  } catch (error) {
    return {
      source: options.source,
      filePath: options.filePath,
      code: 'invalid_definition',
      message: 'Agent definition frontmatter does not match AgentDefinition.',
      issues:
        error instanceof ZodError ? error.issues.map((issue) => issue.message) : [String(error)],
    };
  }
}

export async function loadProjectAgentDefinitions(
  projectRoot: string
): Promise<AgentDefinitionLoadResult> {
  const definitionsDir = join(projectRoot, PROJECT_AGENT_DEFINITIONS_DIR);
  const result: AgentDefinitionLoadResult = { definitions: [], failedFiles: [] };

  let entries: string[];
  try {
    entries = await readdir(definitionsDir);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return result;
    }

    return {
      definitions: [],
      failedFiles: [
        {
          source: 'project',
          filePath: definitionsDir,
          code: 'read_error',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) {
      continue;
    }

    const filePath = join(definitionsDir, entry);
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed = parseAgentDefinitionMarkdown(content, { source: 'project', filePath });
      if (isLoadError(parsed)) {
        result.failedFiles.push(parsed);
      } else {
        result.definitions.push(parsed);
      }
    } catch (error) {
      result.failedFiles.push({
        source: 'project',
        filePath,
        code: 'read_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

function extractFrontmatter(
  content: string,
  options: MarkdownParseOptions
): { frontmatter: string; body: string } | AgentDefinitionLoadError {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      source: options.source,
      filePath: options.filePath,
      code: 'missing_frontmatter',
      message: 'Agent definition markdown must start with --- frontmatter.',
    };
  }

  const closingMarker = '\n---\n';
  const closingIndex = normalized.indexOf(closingMarker, 4);
  if (closingIndex === -1) {
    return {
      source: options.source,
      filePath: options.filePath,
      code: 'malformed_frontmatter',
      message: 'Agent definition markdown frontmatter must close with --- on its own line.',
    };
  }

  return {
    frontmatter: normalized.slice(4, closingIndex),
    body: normalized.slice(closingIndex + closingMarker.length),
  };
}

function parseFrontmatter(
  frontmatter: string,
  options: MarkdownParseOptions
): FrontmatterRecord | AgentDefinitionLoadError {
  const parsed: FrontmatterRecord = {};
  const lines = frontmatter.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (!match) {
      return malformedFrontmatter(options, `Invalid frontmatter line: ${line}`);
    }

    const key = match[1];
    const rawValue = match[2];
    if (rawValue === '') {
      const values: string[] = [];
      while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
        index += 1;
        values.push(unquote(lines[index].replace(/^\s+-\s+/, '').trim()));
      }
      parsed[key] = values;
      continue;
    }

    const value = parseFrontmatterValue(rawValue.trim(), options);
    if (isLoadError(value)) {
      return value;
    }
    parsed[key] = value;
  }

  return parsed;
}

function parseFrontmatterValue(
  value: string,
  options: MarkdownParseOptions
): string | number | boolean | string[] | AgentDefinitionLoadError {
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) {
      return malformedFrontmatter(options, `Invalid inline array: ${value}`);
    }

    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => unquote(item.trim())) : [];
  }

  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  return unquote(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function malformedFrontmatter(
  options: MarkdownParseOptions,
  message: string
): AgentDefinitionLoadError {
  return {
    source: options.source,
    filePath: options.filePath,
    code: 'malformed_frontmatter',
    message,
  };
}

function isLoadError(value: unknown): value is AgentDefinitionLoadError {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
