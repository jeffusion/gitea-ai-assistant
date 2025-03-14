import { Context } from 'hono';
import { giteaService } from '../services/gitea';
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
