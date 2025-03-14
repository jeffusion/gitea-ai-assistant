import { Context } from 'hono';
import { giteaService, PullRequestFile, PullRequestDetails } from '../services/gitea';
import { aiReviewService } from '../services/ai-review';
// import config from '../config';
// import * as crypto from 'crypto';
import { logger } from '../utils/logger';

// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

/**
 * 验证Webhook请求签名
 */
// function verifyWebhookSignature(body: string, signature: string): boolean {
//   // 开发环境下跳过签名验证
//   if (isDev && !signature) {
//     logger.warn('开发环境: 跳过Webhook签名验证');
//     return true;
//   }

//   if (!config.app.webhookSecret) return false;

//   const hmac = crypto.createHmac('sha256', config.app.webhookSecret);
//   hmac.update(body);
//   const calculatedSignature = `sha256=${hmac.digest('hex')}`;

//   // 如果签名不存在，直接返回false
//   if (!signature) return false;

//   try {
//     return crypto.timingSafeEqual(
//       Buffer.from(calculatedSignature),
//       Buffer.from(signature)
//     );
//   } catch (error) {
//     logger.error('签名验证失败', error);
//     return false;
//   }
// }

/**
 * 处理Pull Request事件
 */
export async function handlePullRequestEvent(c: Context): Promise<Response> {
  try {
    // 验证Webhook签名
    // const signature = c.req.header('X-Gitea-Signature') || '';
    const rawBody = await c.req.text();

    // if (!verifyWebhookSignature(rawBody, signature)) {
    //   logger.error('Webhook签名验证失败');
    //   return c.json({ error: 'Webhook签名验证失败' }, 401);
    // }

    // 解析请求体
    const body = JSON.parse(rawBody);

    // 仅处理PR打开或更新事件
    if (
      body.action !== 'opened' &&
      body.action !== 'reopened' &&
      body.action !== 'synchronize' &&
      body.action !== 'edited'
    ) {
      return c.json({ status: 'ignored', message: '无需处理的事件类型' }, 200);
    }

    // 从事件中提取必要信息
    const {
      pull_request: pullRequest,
      repository: repo
    } = body;

    if (!pullRequest || !repo) {
      return c.json({ error: '无效的Webhook数据' }, 400);
    }

    const prNumber = pullRequest.number;
    const owner = repo.owner.login;
    const repoName = repo.name;

    logger.info(`收到PR事件`, { owner, repo: repoName, prNumber, action: body.action });

    // 开始异步审查流程
    reviewPullRequest(owner, repoName, prNumber).catch(error => {
      logger.error(`审查PR ${owner}/${repoName}#${prNumber} 失败:`, error);
    });

    // 立即返回以不阻塞Webhook
    return c.json({ status: 'accepted', message: '代码审查请求已接受' }, 202);
  } catch (error) {
    logger.error('处理Webhook事件失败:', error);
    return c.json({ error: '处理Webhook事件失败' }, 500);
  }
}

/**
 * 处理提交状态更新事件
 */
export async function handleCommitStatusEvent(c: Context): Promise<Response> {
  try {
    const rawBody = await c.req.text();
    const body = JSON.parse(rawBody);

    // 记录收到的数据，方便调试
    logger.debug('收到提交状态webhook数据', {
      state: body.state,
      sha: body.sha,
      commit_id: body.commit?.id,
      context: body.context,
      repo: body.repository?.full_name
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
      modified: body.commit.modified || []
    };

    logger.info(`收到提交状态更新事件`, {
      owner,
      repo: repoName,
      commitSha,
      state: body.state,
      relatedPR: relatedPR?.number || 'unknown',
      added: commitInfo.added.length,
      modified: commitInfo.modified.length,
      removed: commitInfo.removed.length
    });

    // 如果没有文件变更信息，则忽略
    if (commitInfo.added.length === 0 && commitInfo.modified.length === 0 && commitInfo.removed.length === 0) {
      logger.warn('提交没有文件变更信息，忽略审查', { commitSha });
      return c.json({ status: 'ignored', message: '提交没有文件变更信息' }, 200);
    }

    // 开始异步审查流程，传入关联的PR信息
    reviewCommit(owner, repoName, commitSha, commitInfo, relatedPR).catch(error => {
      logger.error(`审查提交 ${owner}/${repoName}@${commitSha} 失败:`, error);
    });

    // 立即返回以不阻塞Webhook
    return c.json({ status: 'accepted', message: '提交代码审查请求已接受' }, 202);
  } catch (error) {
    logger.error('处理提交状态Webhook事件失败:', error);
    return c.json({ error: '处理提交状态Webhook事件失败' }, 500);
  }
}

/**
 * 审查Pull Request的代码
 */
async function reviewPullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
  try {
    logger.info(`开始审查PR ${owner}/${repo}#${prNumber}`);

    // 如果是开发环境，模拟PR差异和详情
    let prDetails;
    let diffContent;

    if (isDev) {
      // 开发环境中的测试数据
      logger.info('开发环境: 使用测试数据');
      prDetails = {
        id: prNumber,
        number: prNumber,
        title: '测试PR',
        head: {
          sha: 'abcd1234abcd1234abcd1234abcd1234abcd1234'
        },
        base: {
          repo: {
            owner: {
              login: owner
            },
            name: repo
          }
        }
      };

      // 测试用diff内容
      diffContent = `diff --git a/test.js b/test.js
index 1234567..abcdefg 100644
--- a/test.js
+++ b/test.js
@@ -1,5 +1,9 @@
 function add(a, b) {
-  return a + b;
+  return a + b; // 简单的加法函数
 }

-console.log(add(1, 2));
+// 不安全的数据处理
+function processUserData(data) {
+  eval(data); // 这里有安全问题
+}
+console.log(add(1, 2));`;
    } else {
      // 生产环境中从Gitea获取真实数据
      [prDetails, diffContent] = await Promise.all([
        giteaService.getPullRequestDetails(owner, repo, prNumber),
        giteaService.getPullRequestDiff(owner, repo, prNumber)
      ]);
    }

    // 提取commit SHA
    const commitId = prDetails.head.sha;

    // 使用增强的AI代码审查服务
    const reviewResult = await aiReviewService.reviewCode(
      owner,
      repo,
      prNumber,
      diffContent,
      commitId
    );

    logger.info('代码审查结果', {
      summary: reviewResult.summary.substring(0, 100) + '...',
      commentCount: reviewResult.lineComments.length
    });

    // 添加总结评论
    if (isDev) {
      logger.info('开发环境: 模拟添加PR评论', {
        comment: reviewResult.summary
      });
    } else {
      logger.info('生产环境: 添加PR评论', {
        owner,
        repo,
        prNumber,
        comment: reviewResult.summary
      });
      await giteaService.addPullRequestComment(
        owner,
        repo,
        prNumber,
        `## AI代码审查结果\n\n${reviewResult.summary}`
      );
    }

    // 添加行级评论
    if (reviewResult.lineComments.length > 0) {
      if (isDev) {
        logger.info('开发环境: 模拟添加行评论', {
          commentCount: reviewResult.lineComments.length,
          comments: reviewResult.lineComments
        });
      } else {
        await giteaService.addLineComments(
          owner,
          repo,
          prNumber,
          commitId,
          reviewResult.lineComments
        );
      }
    }

    logger.info(`完成PR ${owner}/${repo}#${prNumber} 的代码审查`);
  } catch (error) {
    logger.error(`审查PR失败:`, error);
    throw error;
  }
}

/**
 * 审查提交的代码变更
 */
async function reviewCommit(
  owner: string,
  repo: string,
  commitSha: string,
  commitInfo: {
    sha: string,
    message: string,
    added: string[],
    modified: string[],
    removed: string[]
  },
  relatedPR?: PullRequestDetails | null
): Promise<void> {
  try {
    logger.info(`开始审查提交 ${owner}/${repo}@${commitSha}`);
    logger.info('提交信息', {
      message: commitInfo.message.substring(0, 100) + (commitInfo.message.length > 100 ? '...' : ''),
      added: commitInfo.added.length,
      modified: commitInfo.modified.length,
      removed: commitInfo.removed.length
    });

    // 如果是开发环境，打印更多信息但不执行实际审查
    if (isDev) {
      logger.info('开发环境: 正在模拟审查提交', {
        owner,
        repo,
        commitSha,
        added: commitInfo.added,
        modified: commitInfo.modified,
        removed: commitInfo.removed
      });
      return;
    }

    // 创建自定义文件列表，因为Gitea API不直接提供
    const webhookFiles: PullRequestFile[] = [
      ...commitInfo.added.map(filename => ({
        filename,
        status: 'added',
        additions: 0, // 不知道具体行数
        deletions: 0,
        changes: 0
      })),
      ...commitInfo.modified.map(filename => ({
        filename,
        status: 'modified',
        additions: 0,
        deletions: 0,
        changes: 0
      })),
      ...commitInfo.removed.map(filename => ({
        filename,
        status: 'removed',
        additions: 0,
        deletions: 0,
        changes: 0
      }))
    ];

    // 使用AI审查服务分析提交，并传入webhook提供的文件列表
    const reviewResult = await aiReviewService.reviewCommit(
      owner,
      repo,
      commitSha,
      webhookFiles
    );

    logger.info('提交代码审查结果', {
      summary: reviewResult.summary.substring(0, 100) + '...',
      commentCount: reviewResult.lineComments.length
    });

    // 添加总结评论到提交
    try {
      await giteaService.addCommitComment(
        owner,
        repo,
        commitSha,
        `## AI代码审查结果\n\n${reviewResult.summary}`
      );
    } catch (error) {
      logger.error('添加提交评论失败:', error);
      // 继续处理，尝试添加到PR
    }

    // 尝试使用传入的PR信息，或者查找相关的PR
    try {
      // 如果已经有关联PR，直接使用
      if (relatedPR && relatedPR.number) {
        logger.info(`使用已知关联的PR #${relatedPR.number}`);

        // 添加行级评论
        if (reviewResult.lineComments.length > 0) {
          await giteaService.addLineComments(
            owner,
            repo,
            relatedPR.number,
            commitSha,
            reviewResult.lineComments
          );
        }
      } else {
        // 否则尝试查找
        logger.info('尝试查找与提交关联的PR');
        const response = await giteaService.getRelatedPullRequest(owner, repo, commitSha);
        if (response && response.number) {
          logger.info(`找到与提交关联的PR #${response.number}`);

          // 添加行级评论
          if (reviewResult.lineComments.length > 0) {
            await giteaService.addLineComments(
              owner,
              repo,
              response.number,
              commitSha,
              reviewResult.lineComments
            );
          }
        } else {
          logger.info('未找到与提交关联的PR，无法添加行级评论');
        }
      }
    } catch (error) {
      logger.warn('处理PR关联失败，将跳过行级评论', error);
    }

    logger.info(`完成提交 ${owner}/${repo}@${commitSha} 的代码审查`);
  } catch (error) {
    logger.error(`审查提交失败:`, error);
    throw error;
  }
}
