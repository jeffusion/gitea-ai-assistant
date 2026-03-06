import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config';
import { logger } from '../../utils/logger';
import type { LocalRepoManager, LocalRepoPaths } from '../context/local-repo-manager';
import type { FileReviewStore } from '../store/file-review-store';
import type { ReviewRun } from '../types';
import { type ReviewRunContext, mcpToolExecutor } from './mcp-tools';

// ---------------------------------------------------------------------------
// 默认审查提示词
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTIONS = `你是一个专业的代码审查助手。请审查当前仓库中两个分支之间的代码变更。

## 审查步骤

1. **获取审查上下文**：调用 \`get_pr_info\` 工具获取 PR 信息（owner、repo、PR number、base SHA、head SHA）。
2. **获取代码差异**：在终端中执行 \`git diff <baseSha>...<headSha>\` 命令，查看两个分支之间的完整差异。如果差异内容过多，可以先执行 \`git diff --stat <baseSha>...<headSha>\` 了解变更概况，再针对重要文件逐个查看。
3. **分析代码问题**：仔细审查差异中的代码，根据审查原则进行分析。
4. **发布审查结果**：
   - 调用 \`add_review_summary\` 发布整体审查总结
   - 对发现的具体问题，调用 \`add_line_comment\` 在对应代码行添加评论

## 执行规则

- 这是自动化流程，不是对话。不要问候、不要寒暄、不要解释你将要做什么。
- 直接调用工具，不要在调用前描述你的计划或在调用后总结结果。
- 如果没有值得标记的问题，调用 add_review_summary 说明即可，不要额外输出。
- 所有审查工作完成后，回复"DONE"。不要输出其他内容。`;

const DEFAULT_REVIEW_GUIDELINES = `- 关注逻辑错误、潜在 bug、安全漏洞、性能问题、错误处理缺失
- 仅关注本次变更引入的问题，不要评论已有代码
- 只标记作者如果知道了一定会修复的真正问题
- 不要标记代码风格、格式化等非实质性问题
- 评论要简洁明了，直接说明问题和影响
- 如果没有发现值得标记的问题，在总结中说明代码变更看起来没有问题即可
- 行评论中的文件路径使用相对于仓库根目录的路径`;

/**
 * 单次 Codex 审查执行器
 *
 * 负责：
 * 1. 准备工作空间（复用 LocalRepoManager）
 * 2. 生成 .codex/config.toml（含 MCP server 配置）
 * 3. 注册 MCP 审查上下文
 * 4. 启动 codex exec 子进程（自定义 prompt + MCP 工具）
 * 5. 等待 Codex 通过 MCP 工具发布审查评论
 * 6. 清理工作空间
 */
export class CodexRunner {
  constructor(
    private readonly store: FileReviewStore,
    private readonly localRepoManager: LocalRepoManager
  ) {}

  async execute(run: ReviewRun): Promise<void> {
    const targetSha = run.headSha || run.commitSha;
    if (!targetSha) {
      await this.store.markRunIgnored(run.id, '缺少目标 sha');
      return;
    }

    let repoPaths: LocalRepoPaths | null = null;

    try {
      // ── Step 1: 准备工作空间 ──────────────────────────────────
      const workspaceStepStart = Date.now();
      await this.store.addStep({
        runId: run.id,
        stepName: 'codex_prepare_workspace',
        status: 'started',
        startedAt: new Date(workspaceStepStart).toISOString(),
      });

      repoPaths = await this.localRepoManager.prepareWorkspace(
        run.owner,
        run.repo,
        run.cloneUrl,
        targetSha,
        run.id,
        run.headCloneUrl
      );

      await this.store.addStep({
        runId: run.id,
        stepName: 'codex_prepare_workspace',
        status: 'succeeded',
        startedAt: new Date(workspaceStepStart).toISOString(),
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - workspaceStepStart,
      });

      // ── 增量审查基线解析 ─────────────────────────────────────────────────────
      let lastReviewedHead: string | undefined;
      if (run.eventType === 'pull_request' && run.prNumber) {
        const snapshot = await this.localRepoManager.resolveReviewedRef(
          repoPaths.mirrorPath,
          run.prNumber
        );
        if (snapshot && targetSha) {
          if (snapshot.baseSha === run.baseSha) {
            // base 未变（追加 commit 或 force-push 修改 commit）→ 增量审查
            lastReviewedHead = snapshot.headSha;
            logger.info('Codex 增量审查模式：使用上次审查快照', {
              runId: run.id,
              lastReviewedHead: snapshot.headSha,
              currentHead: targetSha,
              baseSha: run.baseSha,
            });
          } else {
            // base 变了（PR 分支做了 rebase）→ 全量审查
            logger.info('Codex PR base 已变更（可能 rebase），回退全量审查', {
              runId: run.id,
              savedBaseSha: snapshot.baseSha,
              currentBaseSha: run.baseSha,
            });
          }
        }
      }

      // ── Step 2: 生成 .codex 配置 ───────────────────────────────
      await this.generateCodexWorkspaceConfig(repoPaths.workspacePath, run.id);

      // ── Step 3: 注册 MCP 上下文 ──────────────────────────────
      const mcpContext: ReviewRunContext = {
        runId: run.id,
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber,
        relatedPrNumber: run.relatedPrNumber,
        commitSha: run.commitSha,
        baseSha: run.baseSha,
        headSha: run.headSha,
        lastReviewedHead,
      };
      mcpToolExecutor.registerContext(mcpContext);

      // ── Step 4: 执行 Codex CLI ────────────────────────────────
      const codexStepStart = Date.now();
      await this.store.addStep({
        runId: run.id,
        stepName: 'codex_review',
        status: 'started',
        startedAt: new Date(codexStepStart).toISOString(),
      });

      await this.runCodexProcess(repoPaths.workspacePath, run, lastReviewedHead);

      await this.store.addStep({
        runId: run.id,
        stepName: 'codex_review',
        status: 'succeeded',
        startedAt: new Date(codexStepStart).toISOString(),
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - codexStepStart,
      });

      logger.info('Codex 审查流程完成', {
        runId: run.id,
        owner: run.owner,
        repo: run.repo,
      });

      // ── 审查成功：保存审查快照 ref ──────────────────────────────────────
      if (run.eventType === 'pull_request' && run.prNumber && targetSha) {
        try {
          await this.localRepoManager.saveReviewedRef(
            repoPaths!.mirrorPath,
            run.prNumber,
            run.baseSha!,
            targetSha
          );
        } catch (refError) {
          logger.warn('Codex 保存审查快照 ref 失败（非致命）', {
            runId: run.id,
            error: refError instanceof Error ? refError.message : String(refError),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.addStep({
        runId: run.id,
        stepName: 'codex_review',
        status: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: message,
      });
      throw error;
    } finally {
      // 清理 MCP 上下文
      mcpToolExecutor.unregisterContext(run.id);

      // 清理工作空间
      if (repoPaths) {
        await this.localRepoManager.cleanupWorkspace(repoPaths);
      }
    }
  }

  private async generateCodexWorkspaceConfig(workspacePath: string, runId: string): Promise<void> {
    const codexConfigDir = path.join(workspacePath, '.codex');
    await mkdir(codexConfigDir, { recursive: true });

    const port = config.app.port;
    const model = config.review.codexModel;
    const apiUrl = this.normalizeApiBaseUrl(config.review.codexApiUrl);
    const apiKey = config.review.codexApiKey;

    // 生成 TOML 配置（含 MCP server）
    const tomlLines: string[] = [
      `model = "${model}"`,
      `model_verbosity = "low"`,
      '',
      '[model_providers.openai]',
      `name = "OpenAI"`,
      `base_url = "${apiUrl}"`,
      `env_key = "OPENAI_API_KEY"`,
      `requires_openai_auth = false`,
      '',
      '[mcp_servers.gitea-review]',
      `url = "http://127.0.0.1:${port}/mcp/gitea-review"`,
      `http_headers = { "X-Review-Run-Id" = "${runId}" }`,
      `required = true`,
      '',
    ];

    await writeFile(path.join(codexConfigDir, 'config.toml'), tomlLines.join('\n'), 'utf-8');

    if (apiKey?.trim()) {
      const authJson = {
        auth_mode: 'api_key',
        OPENAI_API_KEY: apiKey,
      };
      await writeFile(path.join(codexConfigDir, 'auth.json'), JSON.stringify(authJson), 'utf-8');
    }

    logger.debug('已生成 Codex 配置文件', {
      runId,
      configPath: path.join(codexConfigDir, 'config.toml'),
      model,
      apiUrl,
      authMode: apiKey?.trim() ? 'env+auth.json' : 'missing_api_key',
    });
  }

  private normalizeApiBaseUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim().replace(/\/+$/, '');
    if (!trimmed) {
      return 'https://api.openai.com/v1';
    }
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  }

  /**
   * 构建审查提示词
   */
  private buildReviewPrompt(run: ReviewRun, lastReviewedHead?: string): string {
    const customPrompt = config.review.codexReviewPrompt?.trim();
    const globalPrompt = config.review.globalPrompt?.trim();
    const projectPrompt = this.resolveProjectPrompt(run);

    const sections: string[] = [];

    sections.push(SYSTEM_INSTRUCTIONS);

    sections.push(`## 审查原则\n\n${customPrompt || DEFAULT_REVIEW_GUIDELINES}`);

    if (globalPrompt) {
      sections.push(`## 全局审查要求\n\n${globalPrompt}`);
    }

    if (projectPrompt) {
      sections.push(`## 项目级审查要求\n\n${projectPrompt}`);
    }

    sections.push(
      '当要求冲突时，优先级为：项目级审查要求 > 全局审查要求 > 审查原则。'
    );

    const contextLines: string[] = ['## 当前审查目标'];

    if (run.eventType === 'pull_request') {
      contextLines.push('‐ 类型：Pull Request');
      if (run.prNumber) contextLines.push(`- PR 编号：#${run.prNumber}`);
      if (run.baseSha) contextLines.push(`- Base SHA：${run.baseSha}`);
      if (run.headSha) contextLines.push(`- Head SHA：${run.headSha}`);
      if (lastReviewedHead) {
        contextLines.push(`- 增量审查模式：仅审查上次审查后的新变更`);
        contextLines.push(`- 上次审查 SHA：${lastReviewedHead}`);
        contextLines.push(`- 请使用 \`git diff ${lastReviewedHead}..${run.headSha}\` 获取增量差异`);
      } else {
        contextLines.push(`- 请使用 \`git diff ${run.baseSha}...${run.headSha}\` 获取差异`);
      }
    } else if (run.eventType === 'commit_status') {
      contextLines.push('- 类型：Commit');
      if (run.commitSha) {
        contextLines.push(`- Commit SHA：${run.commitSha}`);
        contextLines.push(`- 请使用 \`git diff ${run.commitSha}~1...${run.commitSha}\` 获取差异`);
      }
      if (run.commitMessage) contextLines.push(`- Commit 信息：${run.commitMessage}`);
    }

    sections.push(contextLines.join('\n'));
    return sections.join('\n\n');
  }

  private resolveProjectPrompt(_run: ReviewRun): string | undefined {
    return undefined;
  }

  /**
   * 执行 codex exec 子进程（自定义 prompt + MCP 工具）
   */
  private async runCodexProcess(workspacePath: string, run: ReviewRun, lastReviewedHead?: string): Promise<void> {
    const timeoutMs = config.review.codexTimeoutMs;
    const codexHome = path.join(workspacePath, '.codex');

    // 构建审查提示词
    const prompt = this.buildReviewPrompt(run, lastReviewedHead);

    // 构建命令参数：codex exec --full-auto --ephemeral [PROMPT]
    const args: string[] = ['exec', '--full-auto', '--ephemeral', prompt];

    logger.info('启动 Codex CLI', {
      runId: run.id,
      args: ['codex', 'exec', '--full-auto', '--ephemeral', '<prompt>'].join(' '),
      promptLength: prompt.length,
      cwd: workspacePath,
      timeoutMs,
    });

    const proc = Bun.spawn(['codex', ...args], {
      cwd: workspacePath,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        CODEX_API_KEY: config.review.codexApiKey || '',
        OPENAI_API_KEY: config.review.codexApiKey || '',
        OPENAI_BASE_URL: this.normalizeApiBaseUrl(config.review.codexApiUrl),
        CODEX_HOME: codexHome,
      },
    });

    // 超时控制
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Codex 审查超时（${timeoutMs}ms）`));
      }, timeoutMs);
    });

    // 等待进程完成
    const processPromise = (async () => {
      let fullStderr = '';

      // 并行读取 stdout 和 stderr
      const readStderr = (async () => {
        try {
          const text = await new Response(proc.stderr).text();
          fullStderr = text;
          // 按行输出到日志
          for (const line of text.split('\n')) {
            if (line.trim()) {
              logger.debug('Codex 输出', { runId: run.id, line: line.substring(0, 500) });
            }
          }
        } catch {
          // stream 读取错误不是致命的
        }
      })();

      const readStdout = (async () => {
        try {
          const text = await new Response(proc.stdout).text();
          for (const line of text.split('\n')) {
            if (line.trim()) {
              logger.debug('Codex 结果', { runId: run.id, line: line.substring(0, 500) });
            }
          }
        } catch {
          // stream 读取错误不是致命的
        }
      })();

      // 等待读取完成 + 进程退出
      await Promise.all([readStderr, readStdout]);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error(
          `Codex 进程退出码 ${exitCode}${fullStderr ? `\nstderr: ${fullStderr.substring(0, 2000)}` : ''}`
        );
      }

      logger.info('Codex 进程结束', { runId: run.id, exitCode });
    })();

    await Promise.race([processPromise, timeoutPromise]);
  }
}
