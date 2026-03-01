import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import config from '../config';
import { giteaService } from '../services/gitea';
import { logger } from '../utils/logger';
import { JudgeAgent } from './agents/judge-agent';
import { ReflexionAgent } from './agents/reflexion-agent';
import { DebateOrchestrator } from './agents/debate-orchestrator';
import { DiffExtractor } from './context/diff-extractor';
import { LocalRepoManager, LocalRepoPaths } from './context/local-repo-manager';
import { applyPublishPolicy } from './policy/publish-policy';
import { FileReviewStore } from './store/file-review-store';
import { Finding, ReviewRun } from './types';
import { ToolRegistry } from './tools/registry';
import { createCodeSearchTool } from './tools/code-search-tool';
import { createFunctionReferenceSearchTool } from './tools/function-reference-search-tool';
import { createFileReadTool } from './tools/file-read-tool';
import { VectorMemoryStore } from './memory/vector-store';
import { LearningSystem } from './learning/learning-system';

interface LineCommentInput {
  path: string;
  line: number;
  comment: string;
}

function findingToLineComment(finding: Omit<Finding, 'id' | 'runId' | 'published'>): LineCommentInput {
  return {
    path: finding.path,
    line: finding.line,
    comment: `**[${finding.severity.toUpperCase()}][${finding.category}]** ${finding.title}\n\n${finding.detail}\n\n建议: ${finding.suggestion}`,
  };
}

function summarizeGatedCount(gatedCount: number): string {
  if (gatedCount <= 0) {
    return '';
  }
  return `\n\n> ${gatedCount} 条低置信或低优先级问题已进入人工审批队列。`;
}

export class ReviewOrchestrator {
  private readonly openai: OpenAI;
  private readonly toolRegistry: ToolRegistry;
  private readonly correctnessAgent: ReflexionAgent;
  private readonly securityAgent: ReflexionAgent;
  private readonly reliabilityAgent: ReflexionAgent;
  private readonly maintainabilityAgent: ReflexionAgent;
  private readonly judgeAgent: JudgeAgent;
  private readonly debateOrchestrator: DebateOrchestrator;
  private readonly memoryStore?: VectorMemoryStore;
  private readonly learningSystem?: LearningSystem;

  constructor(
    private readonly store: FileReviewStore,
    private readonly localRepoManager: LocalRepoManager,
    private readonly diffExtractor: DiffExtractor
  ) {
    this.openai = new OpenAI({
      baseURL: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
    });

    // 初始化工具注册表
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.register(createCodeSearchTool(this.diffExtractor.getSandbox()));
    this.toolRegistry.register(createFunctionReferenceSearchTool(this.diffExtractor.getSandbox()));
    this.toolRegistry.register(createFileReadTool());

    logger.info('已注册工具（支持所有编程语言）', {
      tools: this.toolRegistry.getAll().map((t) => t.name),
    });

    // 初始化记忆和学习系统（可选）
    if (config.review.qdrantUrl && config.review.enableMemory) {
      this.memoryStore = new VectorMemoryStore(config.review.qdrantUrl, this.openai);
      this.learningSystem = new LearningSystem(this.memoryStore, this.store);

      this.memoryStore.initialize().catch((err) => {
        logger.warn('向量记忆系统初始化失败', { error: err.message });
      });

      logger.info('向量记忆系统已启用', { qdrantUrl: config.review.qdrantUrl });
    }

    // 创建Reflexion-wrapped agents并传递工具注册表和学习系统
    this.correctnessAgent = new ReflexionAgent(
      this.openai,
      config.review.modelSpecialist,
      'correctness',
      'Correctness Agent',
      '业务逻辑正确性、边界条件、空值处理和明显bug',
      this.toolRegistry,
      this.learningSystem
    );

    this.securityAgent = new ReflexionAgent(
      this.openai,
      config.review.modelSpecialist,
      'security',
      'Security Agent',
      '注入漏洞、权限绕过、敏感信息泄露、反序列化和输入校验缺失',
      this.toolRegistry,
      this.learningSystem
    );

    this.reliabilityAgent = new ReflexionAgent(
      this.openai,
      config.review.modelSpecialist,
      'reliability',
      'Reliability Agent',
      '错误处理、重试策略、幂等性、并发一致性和资源释放',
      this.toolRegistry,
      this.learningSystem
    );

    this.maintainabilityAgent = new ReflexionAgent(
      this.openai,
      config.review.modelSpecialist,
      'maintainability',
      'Maintainability Agent',
      '可维护性、复杂度、接口破坏风险和可测试性不足',
      this.toolRegistry,
      this.learningSystem
    );

    this.judgeAgent = new JudgeAgent();
    this.debateOrchestrator = new DebateOrchestrator(this.openai, config.review.modelSpecialist);
  }

  async execute(run: ReviewRun): Promise<void> {
    const targetSha = run.headSha || run.commitSha;
    if (!targetSha) {
      await this.store.markRunIgnored(run.id, '缺少目标 sha');
      return;
    }

    const workspaceStepStart = Date.now();
    await this.store.addStep({
      runId: run.id,
      stepName: 'prepare_workspace',
      status: 'started',
      startedAt: new Date(workspaceStepStart).toISOString(),
    });

    let repoPaths: LocalRepoPaths | null = null;

    try {
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
        stepName: 'prepare_workspace',
        status: 'succeeded',
        startedAt: new Date(workspaceStepStart).toISOString(),
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - workspaceStepStart,
      });

      const contextStart = Date.now();
      await this.store.addStep({
        runId: run.id,
        stepName: 'build_context',
        status: 'started',
        startedAt: new Date(contextStart).toISOString(),
      });

      const context = await this.diffExtractor.buildContext(run, repoPaths.mirrorPath, repoPaths.workspacePath);

      await this.store.addStep({
        runId: run.id,
        stepName: 'build_context',
        status: 'succeeded',
        startedAt: new Date(contextStart).toISOString(),
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - contextStart,
      });

      if (!context.diff.trim()) {
        await this.publishSummary(run, '本次变更无可审查差异内容，已跳过自动行级评论。', 0);
        await this.store.markRunIgnored(run.id, '无可审查差异');
        return;
      }

      const agentStart = Date.now();
      await this.store.addStep({
        runId: run.id,
        stepName: 'run_specialists',
        status: 'started',
        startedAt: new Date(agentStart).toISOString(),
      });

      // 使用Reflection模式运行specialists
      const enableReflection = config.review.enableReflection ?? false;
      const maxReflectionRounds = config.review.maxReflectionRounds ?? 2;

      const agentResults = await Promise.all([
        enableReflection
          ? this.correctnessAgent.reviewWithReflection(run, context, maxReflectionRounds)
          : this.correctnessAgent.review(run, context),
        enableReflection
          ? this.securityAgent.reviewWithReflection(run, context, maxReflectionRounds)
          : this.securityAgent.review(run, context),
        enableReflection
          ? this.reliabilityAgent.reviewWithReflection(run, context, maxReflectionRounds)
          : this.reliabilityAgent.review(run, context),
        enableReflection
          ? this.maintainabilityAgent.reviewWithReflection(run, context, maxReflectionRounds)
          : this.maintainabilityAgent.review(run, context),
      ]);

      await this.store.addStep({
        runId: run.id,
        stepName: 'run_specialists',
        status: 'succeeded',
        startedAt: new Date(agentStart).toISOString(),
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - agentStart,
      });

      let allFindings = agentResults.flatMap((result) => result.findings);

      // 对高严重性findings启动Debate
      const enableDebate = config.review.enableDebate ?? false;
      const debateThreshold = config.review.debateThreshold ?? 'high';

      if (enableDebate && allFindings.length > 0) {
        const debateStart = Date.now();
        await this.store.addStep({
          runId: run.id,
          stepName: 'debate_high_severity',
          status: 'started',
          startedAt: new Date(debateStart).toISOString(),
        });

        const debatableFindings = allFindings.filter((f) => {
          if (debateThreshold === 'high') return f.severity === 'high';
          if (debateThreshold === 'medium') return f.severity === 'high' || f.severity === 'medium';
          return false;
        });

        logger.info('启动Debate阶段', {
          runId: run.id,
          totalFindings: allFindings.length,
          debatableFindings: debatableFindings.length,
          threshold: debateThreshold,
        });

        const debatedFindings: typeof allFindings = [];
        for (const finding of debatableFindings) {
          const debatedFinding = await this.debateOrchestrator.conductDebate(finding, [
            this.correctnessAgent,
            this.securityAgent,
            this.reliabilityAgent,
            this.maintainabilityAgent,
          ]);
          debatedFindings.push(debatedFinding);
        }

        // 替换原findings
        allFindings = [
          ...debatedFindings,
          ...allFindings.filter((f) => !debatableFindings.includes(f)),
        ];

        await this.store.addStep({
          runId: run.id,
          stepName: 'debate_high_severity',
          status: 'succeeded',
          startedAt: new Date(debateStart).toISOString(),
          finishedAt: new Date().toISOString(),
          latencyMs: Date.now() - debateStart,
        });
      }

      const decision = this.judgeAgent.judge(allFindings);
      const policyResult = applyPublishPolicy(
        decision.findings,
        config.review.autoPublishMinConfidence,
        config.review.enableHumanGate
      );

      // 检查是否重试：检测summary或line comments是否已发布，避免重复发布
      // summary comment特征：status='published' 且 path字段为空
      // line comment特征：status='published' 且 path字段存在
      const runDetails = await this.store.getRunDetails(run.id);
      const summaryPublished = runDetails?.comments.some(
        (comment) => comment.status === 'published' && !comment.path
      ) || false;
      const lineCommentsPublished = runDetails?.comments.some(
        (comment) => comment.status === 'published' && comment.path
      ) || false;

      if (lineCommentsPublished) {
        logger.info('检测到重试且line comments已发布，跳过line comments和findings标记', {
          runId: run.id,
          existingLineComments: runDetails?.comments.filter(c => c.path).length,
        });
        // 重试场景：line comments已发布，跳过line comments发布步骤
        // 注意：不能return，需要继续执行summary和pending gate记录（即使summary已存在）
      }

      // 只持久化publishable和gated的findings（human gate禁用时丢弃低质量findings）
      // 避免将不会发布也不会人工审批的findings加入pending队列
      const findingsToStore = [...policyResult.publishable, ...policyResult.gated];

      // 创建fingerprint -> published状态的映射，用于在retry时恢复published状态
      // 防止addFindings覆盖时将已发布的findings重置为unpublished
      const existingPublishedStatus = new Map<string, boolean>();
      if (runDetails?.findings) {
        for (const f of runDetails.findings) {
          existingPublishedStatus.set(f.fingerprint, f.published);
        }
      }

      const persistedFindings: Finding[] = findingsToStore.map((finding) => ({
        ...finding,
        id: randomUUID(),
        runId: run.id,
        // 如果finding已经published（retry场景），保留published状态，否则设为false
        published: existingPublishedStatus.get(finding.fingerprint) || false,
      }));
      await this.store.addFindings(run.id, persistedFindings);

      // 先发布line comments（可重试步骤），成功后再发布summary
      // 顺序重要：如果publishLineComments失败导致重试，不会重复发布summary
      if (!lineCommentsPublished) {
        // 首次执行：发布line comments并标记findings
        const lineComments = policyResult.publishable.map(findingToLineComment);
        const lineCommentsPublishedSuccessfully = await this.publishLineComments(run, lineComments);

        // 只有实际发布了line comments才标记findings为published
        // 避免在无PR number等场景下findings消失但开发者没收到评论
        if (lineCommentsPublishedSuccessfully) {
          for (const finding of policyResult.publishable) {
            await this.store.markFindingPublished(run.id, finding.fingerprint);
          }
        }
      } else {
        // Retry场景：line comments已发布，reconcile所有publishable findings的published状态
        // 防止crash/store write失败发生在markFindingPublished中间时，部分findings永远保持unpublished
        for (const finding of policyResult.publishable) {
          await this.store.markFindingPublished(run.id, finding.fingerprint);
        }
      }

      // Summary放在最后：line comments和markFindingPublished都成功后才发布
      // 如果前面步骤失败重试，不会产生重复summary
      if (!summaryPublished) {
        await this.publishSummary(run, decision.summaryMarkdown, policyResult.gated.length);
      } else {
        logger.info('Summary已发布，跳过重复发布', { runId: run.id });
      }

      // 关键：即使summary已存在，仍需添加gated findings到pending队列
      // 防止crash发生在publishSummary之后、addCommentRecord之前时丢失待审批findings
      // 使用幂等性检查防止retry时重复添加
      const existingPendingComments = runDetails?.comments.filter(c => c.status === 'pending') || [];

      // 跟踪本次循环中已添加的location，防止同一run中多个findings在同一位置导致重复pending记录
      const addedLocations = new Set<string>();

      for (const finding of policyResult.gated) {
        const locationKey = `${finding.path}:${finding.line}`;

        // 检查是否已存在相同的pending记录（通过runId + path + line去重）
        // 需要同时检查：1) 之前run的记录 2) 本次循环已添加的记录
        const alreadyPending =
          existingPendingComments.some(c => c.path === finding.path && c.line === finding.line) ||
          addedLocations.has(locationKey);

        if (!alreadyPending) {
          await this.store.addCommentRecord({
            runId: run.id,
            status: 'pending',
            body: `PENDING: ${finding.title}`,
            path: finding.path,
            line: finding.line,
            fingerprint: finding.fingerprint,
          });
          addedLocations.add(locationKey);
        } else {
          logger.debug('跳过已存在的pending记录', {
            runId: run.id,
            path: finding.path,
            line: finding.line,
          });
        }
      }

      // 将已发布的findings存储到向量记忆（自动标记为已批准）
      if (this.memoryStore && policyResult.publishable.length > 0) {
        for (const finding of policyResult.publishable) {
          const persistedFinding = persistedFindings.find((f) => f.fingerprint === finding.fingerprint);
          if (persistedFinding) {
            try {
              await this.memoryStore.storeFinding(persistedFinding as Finding, true, run.owner, run.repo);
            } catch (error) {
              logger.warn('存储finding到向量记忆失败', {
                findingId: persistedFinding.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        logger.debug('已发布findings已存储到向量记忆', {
          count: policyResult.publishable.length,
        });
      }

      logger.info('Agent 审查流程完成', {
        runId: run.id,
        owner: run.owner,
        repo: run.repo,
        findings: decision.findings.length,
        published: policyResult.publishable.length,
        gated: policyResult.gated.length,
        dropped: policyResult.dropped.length,
      });
    } catch (error) {
      await this.store.addStep({
        runId: run.id,
        stepName: 'orchestrator',
        status: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (repoPaths) {
        await this.localRepoManager.cleanupWorkspace(repoPaths);
      }
    }
  }

  private async publishSummary(run: ReviewRun, summary: string, gatedCount: number): Promise<void> {
    const body = `## AI Agent代码审查结果\n\n${summary}${summarizeGatedCount(gatedCount)}`;

    if (run.eventType === 'pull_request' && run.prNumber) {
      await giteaService.addPullRequestComment(run.owner, run.repo, run.prNumber, body);

      // 尝试写入本地record，失败不抛出（避免阻塞整个审查流程）
      // 如果失败，retry时会因缺少record重复发布summary（可接受的权衡）
      try {
        await this.store.addCommentRecord({
          runId: run.id,
          status: 'published',
          body,
        });
      } catch (storeError) {
        logger.error('Failed to persist summary comment record (non-fatal, may cause duplicate on retry)', {
          runId: run.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
        // 不抛出，允许审查流程继续
      }
      return;
    }

    if (run.commitSha) {
      await giteaService.addCommitComment(run.owner, run.repo, run.commitSha, body);

      try {
        await this.store.addCommentRecord({
          runId: run.id,
          status: 'published',
          body,
        });
      } catch (storeError) {
        logger.error('Failed to persist summary comment record (non-fatal, may cause duplicate on retry)', {
          runId: run.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
        // 不抛出，允许审查流程继续
      }
    }
  }

  private async publishLineComments(run: ReviewRun, comments: LineCommentInput[]): Promise<boolean> {
    if (comments.length === 0) {
      return false;
    }

    const commitId = run.commitSha || run.headSha;
    if (!commitId) {
      return false;
    }

    let prNumber = run.prNumber || run.relatedPrNumber;
    if (!prNumber) {
      const related = await giteaService.getRelatedPullRequest(run.owner, run.repo, commitId);
      prNumber = related?.number;
    }

    if (!prNumber) {
      return false;
    }

    await giteaService.addLineComments(run.owner, run.repo, prNumber, commitId, comments);

    // 尝试为每个comment写入本地record，失败不抛出（避免阻塞整个审查流程）
    // 如果部分失败，retry时lineCommentsPublished可能为false/partial，导致重复发布（可接受的权衡）
    for (const comment of comments) {
      try {
        await this.store.addCommentRecord({
          runId: run.id,
          status: 'published',
          path: comment.path,
          line: comment.line,
          body: comment.comment,
        });
      } catch (storeError) {
        logger.error('Failed to persist line comment record (non-fatal, may cause duplicate on retry)', {
          runId: run.id,
          path: comment.path,
          line: comment.line,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
        // 不抛出，继续处理下一条comment
      }
    }

    return true; // 成功发布
  }
}
