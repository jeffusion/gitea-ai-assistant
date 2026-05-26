import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentRegistry,
  loadAgentRegistry,
  loadProjectAgentDefinitions,
  parseAgentDefinitionMarkdown,
} from '..';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function definition(source: 'built-in' | 'plugin' | 'user' | 'project', name: string) {
  return {
    agentType: 'reviewer',
    name,
    whenToUse: `Use ${name}`,
    source,
    model: `${name}-model`,
  };
}

async function makeProjectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-registry-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('AgentRegistry', () => {
  test('keeps all agents and resolves duplicates by built-in < plugin < user < project precedence', () => {
    const registry = createAgentRegistry({
      builtIn: [definition('built-in', 'built-in-reviewer')],
      plugin: [definition('plugin', 'plugin-reviewer')],
      user: [definition('user', 'user-reviewer')],
      project: [definition('project', 'project-reviewer')],
    });

    expect(registry.allAgents.map((agent) => agent.name)).toEqual([
      'built-in-reviewer',
      'plugin-reviewer',
      'user-reviewer',
      'project-reviewer',
    ]);
    expect(registry.activeAgents).toHaveLength(1);
    expect(registry.getActiveAgent('reviewer')?.name).toBe('project-reviewer');
    expect(registry.getActiveAgent('reviewer')?.source).toBe('project');
  });

  test('loads project definitions only from .gitea-assistant/agents/*.md', async () => {
    const projectRoot = await makeProjectRoot();
    const validDir = join(projectRoot, '.gitea-assistant', 'agents');
    const ignoredDir = join(projectRoot, 'agents');
    await mkdir(validDir, { recursive: true });
    await mkdir(ignoredDir, { recursive: true });
    await writeFile(
      join(validDir, 'reviewer.md'),
      [
        '---',
        'agentType: reviewer',
        'name: Project Reviewer',
        'whenToUse: Use for project-specific review.',
        'tools: [readFile, searchCode]',
        'maxTurns: 2',
        'background: true',
        '---',
        'You are the project reviewer.',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      join(ignoredDir, 'ignored.md'),
      ['---', 'agentType: ignored', 'name: Ignored', 'whenToUse: Never.', '---', 'Ignored.'].join(
        '\n'
      ),
      'utf8'
    );

    const loaded = await loadProjectAgentDefinitions(projectRoot);

    expect(loaded.failedFiles).toEqual([]);
    expect(loaded.definitions).toHaveLength(1);
    expect(loaded.definitions[0].agentType).toBe('reviewer');
    expect(loaded.definitions[0].source).toBe('project');
    expect(loaded.definitions[0].tools).toEqual(['readFile', 'searchCode']);
    expect(loaded.definitions[0].maxTurns).toBe(2);
    expect(loaded.definitions[0].background).toBe(true);
    expect(loaded.definitions[0].getSystemPrompt?.()).toBe('You are the project reviewer.');
  });

  test('keeps optional model definitions valid through markdown loading', async () => {
    const parsed = parseAgentDefinitionMarkdown(
      [
        '---',
        'agentType: reviewer',
        'name: No Model Reviewer',
        'whenToUse: Use without model.',
        '---',
        'Prompt body.',
      ].join('\n'),
      { source: 'project', filePath: '/tmp/reviewer.md' }
    );

    expect('code' in parsed).toBe(false);
    if ('code' in parsed) {
      throw new Error('expected valid definition');
    }
    expect(parsed.model).toBeUndefined();
    expect(parsed.getSystemPrompt?.()).toBe('Prompt body.');
  });

  test('returns structured load errors for malformed frontmatter and empty body', async () => {
    const projectRoot = await makeProjectRoot();
    const agentsDir = join(projectRoot, '.gitea-assistant', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'bad-frontmatter.md'),
      '---\nagentType [reviewer]\n---\nPrompt.',
      'utf8'
    );
    await writeFile(
      join(agentsDir, 'empty-body.md'),
      [
        '---',
        'agentType: reviewer',
        'name: Empty Body',
        'whenToUse: Use never.',
        '---',
        '   ',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      join(agentsDir, 'invalid-definition.md'),
      ['---', 'agentType: reviewer', 'name: Missing Use', '---', 'Prompt.'].join('\n'),
      'utf8'
    );

    const loaded = await loadProjectAgentDefinitions(projectRoot);

    expect(loaded.definitions).toEqual([]);
    expect(loaded.failedFiles.map((error) => error.code).sort()).toEqual([
      'empty_body',
      'invalid_definition',
      'malformed_frontmatter',
    ]);
    expect(loaded.failedFiles.every((error) => error.source === 'project')).toBe(true);
    expect(
      loaded.failedFiles.find((error) => error.code === 'invalid_definition')?.issues?.length
    ).toBeGreaterThan(0);
  });

  test('loadAgentRegistry combines built-in, plugin, user, and loaded project definitions', async () => {
    const projectRoot = await makeProjectRoot();
    const agentsDir = join(projectRoot, '.gitea-assistant', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      [
        '---',
        'agentType: reviewer',
        'name: Loaded Project',
        'whenToUse: Use loaded project.',
        '---',
        'Project prompt.',
      ].join('\n'),
      'utf8'
    );

    const registry = await loadAgentRegistry({
      projectRoot,
      builtIn: [definition('built-in', 'Built In')],
      plugin: [definition('plugin', 'Plugin')],
      user: [definition('user', 'User')],
    });

    expect(registry.allAgents).toHaveLength(4);
    expect(registry.failedFiles).toEqual([]);
    expect(registry.getActiveAgent('reviewer')?.name).toBe('Loaded Project');
    expect(registry.getActiveAgent('reviewer')?.getSystemPrompt?.()).toBe('Project prompt.');
  });
});
