import * as crypto from 'node:crypto';
import { Context } from 'hono';
import { map } from 'lodash-es';
import config from '../config';
import { codexEngine } from '../review/codex/codex-engine';
import { LocalRepoManager } from '../review/context/local-repo-manager';
import { SandboxExec } from '../review/context/sandbox-exec';
import { reviewEngine } from '../review/engine';
import { PullRequestDetails, giteaService } from '../services/gitea';
import { getNotificationManager } from '../services/notification-manager';
import type { NotificationContext } from '../services/notification/types';
import { logger } from '../utils/logger';

// Gitea webhook事件类型
enum GiteaEventType {
  PullRequest = 'pull_request',
  Status = 'status',
  Issue = 'issues',
  Unknown = 'unknown',
}

/**
 * 验证Webhook请求签名
 */
function verifyWebhookSignature(body: string, signature: string): boolean {
  if (!config.app.webhookSecret) {
    logger.warn('未配置Webhook密钥，跳过签名验证');
    return false;
  }

  // Gitea使用SHA-256哈希算法
  const hmac = crypto.createHmac('sha256', config.app.webhookSecret);
  hmac.update(body);
  const calculatedSignature = hmac.digest('hex');

  // 如果签名不存在，直接返回false
  if (!signature) {
    logger.warn('请求中无签名头');
    return false;
  }

  // Gitea的签名没有前缀，直接比较
  try {
    // 使用timingSafeEqual进行常量时间比较，防止时序攻击
    return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signature));
  } catch (error) {
    logger.error('签名验证失败', error);
    return false;
  }
}

/**
 * 确定Gitea Webhook事件类型
 */
function determineEventType(c: Context, body: any): GiteaEventType {
  // 优先从请求头获取事件类型
  const eventHeader = c.req.header('X-Gitea-Event');
  if (eventHeader) {
    if (eventHeader === 'pull_request') return GiteaEventType.PullRequest;
    if (eventHeader === 'status') return GiteaEventType.Status;
    if (eventHeader === 'issues') return GiteaEventType.Issue;
  }

  // 如果没有事件头，尝试从请求体判断
  if (body.pull_request) return GiteaEventType.PullRequest;
  if (body.state && (body.sha || body.commit)) return GiteaEventType.Status;
  if (body.issue) return GiteaEventType.Issue;

  // 无法确定事件类型
  return GiteaEventType.Unknown;
}

function resolveCloneUrl(repo: any): string | null {
  if (repo?.clone_url && typeof repo.clone_url === 'string') {
    return repo.clone_url;
  }
  if (repo?.ssh_url && typeof repo.ssh_url === 'string') {
    return repo.ssh_url;
  }
  if (repo?.html_url && typeof repo.html_url === 'string') {
    return `${repo.html_url}.git`;
  }
  return null;
}

/**
 * 处理Pull Request事件
 */
async function handlePullRequestEvent(c: Context, body: any): Promise<Response> {
  // 仅处理PR打开或更新事件
  if (
    body.action !== 'opened' &&
    body.action !== 'reopened' &&
    body.action !== 'synchronize' &&
    body.action !== 'edited' &&
    body.action !== 'review_requested'
  ) {
    // PR 关闭/合并事件 → 清理审查快照 refs
    if (body.action === 'closed') {
      return handlePullRequestClosed(c, body);
    }

    return c.json({ status: 'ignored', message: '无需处理的事件类型' }, 200);
  }

  // 从事件中提取必要信息
  const { pull_request: pullRequest, repository: repo } = body;

  if (!pullRequest || !repo || !repo.owner?.login || !repo.name) {
    return c.json({ error: '无效的Webhook数据' }, 400);
  }

  const prNumber = pullRequest.number;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const prTitle = pullRequest.title;
  const prUrl = pullRequest.html_url;

  logger.info('收到PR事件', { owner, repo: repoName, prNumber, action: body.action });

  // 处理PR审阅者通知（支持多平台）
  try {
    const reviewerUsernames = map(
      pullRequest.requested_reviewers,
      (reviewer) => reviewer.full_name || reviewer.login
    );

    if (reviewerUsernames.length > 0) {
      logger.info('PR有指定审阅者', {
        prNumber,
        reviewers: reviewerUsernames.join(','),
      });
    }

    const notificationManager = getNotificationManager();
    const context: NotificationContext = {
      prTitle,
      prUrl,
      prNumber,
      reviewers: reviewerUsernames,
      repository: repoName,
      owner,
      actor: body.sender?.login,
    };

    // 处理PR创建事件
    if (body.action === 'opened' && reviewerUsernames.length > 0) {
      await notificationManager.notifyPrCreated(context);
    }

    // 处理审阅者指派事件
    if (body.action === 'review_requested' && body.requested_reviewer) {
      const newReviewerUsername =
        body.requested_reviewer.full_name || body.requested_reviewer.login;
      if (newReviewerUsername) {
        context.assignees = [newReviewerUsername];
        await notificationManager.notifyPrReviewerAssigned(context);
      }
    }
  } catch (error) {
    logger.error('处理PR审阅者通知失败:', error);
  }

  // Fork PR策略：始终clone base repo（保证有baseSha），headCloneUrl作为额外remote（保证有headSha）
  const baseCloneUrl = resolveCloneUrl(repo);
  const headSha = pullRequest.head?.sha;
  const baseSha = pullRequest.base?.sha;
  if (!baseCloneUrl || !headSha || !baseSha) {
    return c.json({ error: '缺少审查所需字段(clone_url/base sha/head sha)' }, 400);
  }

  // 检测fork PR：head.repo存在且与base repo不同
  const headCloneUrl = pullRequest.head?.repo ? resolveCloneUrl(pullRequest.head.repo) : undefined;
  const isForkPR = headCloneUrl && headCloneUrl !== baseCloneUrl;

  // 包含baseSha以支持retarget场景：相同headSha但baseSha变化时需要重新审查
  const idempotencyKey = `${owner}/${repoName}#${prNumber}:${baseSha}...${headSha}`;
  const engineInstance = config.review.engine === 'codex' ? codexEngine : reviewEngine;
  const { run, reused } = await engineInstance.enqueuePullRequest({
    eventType: 'pull_request',
    idempotencyKey,
    owner,
    repo: repoName,
    cloneUrl: baseCloneUrl,
    headCloneUrl: isForkPR ? headCloneUrl : undefined,
    prNumber,
    baseSha,
    headSha,
  });

  const engineLabel = config.review.engine === 'codex' ? 'Codex' : 'Agent';
  return c.json(
    {
      status: reused ? 'deduplicated' : 'accepted',
      message: reused ? '审查任务已存在，已去重' : `${engineLabel}代码审查任务已入队`,
      runId: run.id,
    },
    202
  );
}

/**
 * 处理 PR 关闭/合并事件：清理审查快照 refs
 */
async function handlePullRequestClosed(c: Context, body: any): Promise<Response> {
  const { pull_request: pullRequest, repository: repo } = body;
  if (!pullRequest || !repo || !repo.owner?.login || !repo.name) {
    return c.json({ status: 'ignored', message: 'PR close 无效数据' }, 200);
  }

  const prNumber = pullRequest.number;
  const owner = repo.owner.login;
  const repoName = repo.name;

  logger.info('PR 已关闭，开始清理审查快照', {
    owner,
    repo: repoName,
    prNumber,
    merged: !!pullRequest.merged,
  });

  // 异步清理，不阻塞 webhook 响应
  (async () => {
    try {
      const sandboxExec = new SandboxExec(config.review.allowedCommands);
      const localRepoManager = new LocalRepoManager(
        config.review.workdir,
        sandboxExec,
        config.review.commandTimeoutMs,
        config.gitea.accessToken
      );
      const mirrorPath = localRepoManager.getMirrorPath(owner, repoName);

      // 检查 mirror 是否存在（可能从未审查过该仓库）
      const { access } = await import('node:fs/promises');
      try {
        await access(mirrorPath);
      } catch {
        return; // mirror 不存在，无需清理
      }

      await localRepoManager.deleteReviewedRefs(mirrorPath, prNumber);
    } catch (error) {
      logger.warn('PR 关闭清理失败（非致命）', {
        owner,
        repo: repoName,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return c.json({ status: 'accepted', message: 'PR 关闭清理已触发' }, 200);
}

/**
 * 处理提交状态更新事件
 */
async function handleCommitStatusEvent(c: Context, body: any): Promise<Response> {
  // 记录收到的数据，方便调试
  logger.debug('收到提交状态webhook数据', {
    state: body.state,
    sha: body.sha,
    commit_id: body.commit?.id,
    context: body.context,
    repo: body.repository?.full_name,
  });

  // 验证请求体中是否包含必要信息
  if (!body.commit || !body.repository || !body.state) {
    logger.error('无效的Webhook数据', { body: JSON.stringify(body).substring(0, 500) });
    return c.json({ error: '无效的Webhook数据' }, 400);
  }

  // 只处理成功状态的提交
  if (body.state !== 'success') {
    return c.json({ status: 'ignored', message: `忽略非成功状态的提交: ${body.state}` }, 200);
  }

  // 获取关键信息
  const commitSha = body.sha || body.commit.id; // 兼容不同版本的Gitea
  const owner = body.repository.owner.login;
  const repoName = body.repository.name;

  // 检查提交是否与PR相关
  let relatedPR: PullRequestDetails | null = null;
  try {
    relatedPR = await giteaService.getRelatedPullRequest(owner, repoName, commitSha);
    if (!relatedPR) {
      logger.info(`提交 ${commitSha} 不与任何PR关联，跳过审查`);
      return c.json({ status: 'ignored', message: '提交不与任何PR关联' }, 200);
    }
    logger.info(`提交 ${commitSha} 关联到PR #${relatedPR.number}`);
  } catch (error) {
    logger.warn(`检查提交 ${commitSha} 是否与PR关联时出错`, error);
    // 继续处理，因为有可能API临时错误，但提交仍需审查
  }

  // 提取commit信息
  const commitInfo = {
    sha: commitSha,
    message: body.commit.message || '',
    added: body.commit.added || [],
    removed: body.commit.removed || [],
    modified: body.commit.modified || [],
  };

  logger.info('收到提交状态更新事件', {
    owner,
    repo: repoName,
    commitSha,
    state: body.state,
    relatedPR: relatedPR?.number || 'unknown',
    added: commitInfo.added.length,
    modified: commitInfo.modified.length,
    removed: commitInfo.removed.length,
  });

  const cloneUrl = resolveCloneUrl(body.repository);
  if (!cloneUrl) {
    return c.json({ error: '缺少审查所需字段(clone_url)' }, 400);
  }

  const idempotencyKey = `${owner}/${repoName}@${commitSha}`;
  const engineInstance = config.review.engine === 'codex' ? codexEngine : reviewEngine;
  const { run, reused } = await engineInstance.enqueueCommit({
    eventType: 'commit_status',
    idempotencyKey,
    owner,
    repo: repoName,
    cloneUrl,
    commitSha,
    commitMessage: commitInfo.message,
    relatedPrNumber: relatedPR?.number,
  });

  const engineLabel = config.review.engine === 'codex' ? 'Codex' : 'Agent';
  return c.json(
    {
      status: reused ? 'deduplicated' : 'accepted',
      message: reused ? '审查任务已存在，已去重' : `${engineLabel}提交审查任务已入队`,
      runId: run.id,
    },
    202
  );
}

/**
 * 处理工单事件
 */
async function handleIssueEvent(c: Context, body: any): Promise<Response> {
  const { action, issue, repository } = body;

  if (!issue || !repository) {
    return c.json({ error: '无效的Webhook数据' }, 400);
  }

  const issueTitle = issue.title;
  const issueUrl = issue.html_url;
  const creatorUsername = issue.user.full_name || issue.user.login;
  const assigneeUsernames = map(
    issue.assignees,
    (assignee) => assignee.full_name || assignee.login
  );

  logger.info('收到工单事件', {
    action,
    issueTitle,
    issueUrl,
    creatorUsername,
    assigneeUsernames: assigneeUsernames.join(','),
  });

  try {
    const notificationManager = getNotificationManager();
    const context: NotificationContext = {
      issueTitle,
      issueUrl,
      issueNumber: issue.number,
      creator: creatorUsername,
      assignees: assigneeUsernames,
      repository: repository.name,
      owner: repository.owner?.login,
      actor: body.sender?.login,
    };

    if (action === 'opened' && assigneeUsernames.length > 0) {
      await notificationManager.notifyIssueCreated(context);
    } else if (action === 'closed') {
      await notificationManager.notifyIssueClosed(context);
    } else if (action === 'assigned' && assigneeUsernames.length > 0) {
      await notificationManager.notifyIssueAssigned(context);
    }
  } catch (error) {
    logger.error('新通知系统处理工单事件失败:', error);
  }

  return c.json({ status: 'success', message: '工单事件处理完成' }, 200);
}

/**
 * 统一处理Gitea Webhook事件
 */
export async function handleGiteaWebhook(c: Context): Promise<Response> {
  try {
    // 验证Webhook签名
    const signature = c.req.header('X-Gitea-Signature') || '';
    const rawBody = await c.req.text();

    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.error('Webhook签名验证失败');
      return c.json({ error: 'Webhook签名验证失败' }, 401);
    }

    // 解析请求体
    const body = JSON.parse(rawBody);

    // 确定事件类型
    const eventType = determineEventType(c, body);
    logger.info(`收到Gitea Webhook事件: ${eventType}`);

    // 根据事件类型路由到相应的处理逻辑
    switch (eventType) {
      case GiteaEventType.PullRequest:
        return await handlePullRequestEvent(c, body);
      case GiteaEventType.Status:
        return await handleCommitStatusEvent(c, body);
      case GiteaEventType.Issue:
        return await handleIssueEvent(c, body);
      default:
        logger.warn(`未支持的Webhook事件类型: ${eventType}`);
        return c.json({ status: 'ignored', message: '未支持的Webhook事件类型' }, 200);
    }
  } catch (error) {
    logger.error('处理Gitea Webhook事件失败:', error);
    return c.json({ error: '处理Gitea Webhook事件失败' }, 500);
  }
}
