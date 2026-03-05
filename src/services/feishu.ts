import * as crypto from 'node:crypto';
import config from '../config';
import { logger } from '../utils/logger';

export class FeishuService {
  /**
   * 判断飞书通知是否已启用
   */
  isEnabled(): boolean {
    return !!config.feishu.webhookUrl;
  }

  /**
   * 生成飞书消息签名
   * @param timestamp 时间戳
   * @param secret 密钥
   */
  private generateSign(timestamp: string, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', stringToSign);
    return hmac.digest('base64');
  }

  /**
   * 发送飞书消息
   * @param content 消息内容
   * @param usernames 需要@的用户名列表
   */
  async sendMessage(content: string, usernames: string[] = []): Promise<void> {
    const webhookUrl = config.feishu.webhookUrl;
    const webhookSecret = config.feishu.webhookSecret;

    if (!webhookUrl) {
      logger.debug('飞书通知已跳过: webhook URL未配置');
      return;
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const message: any = {
        msg_type: 'text',
        content: {
          text: content,
        },
      };

      // 如果需要@用户，添加at信息
      if (usernames.length > 0) {
        message.content.text += '\n';
        usernames.forEach((username) => {
          message.content.text += `@${username} `;
        });
      }

      // 如果配置了密钥，添加签名
      if (webhookSecret) {
        message.timestamp = timestamp;
        message.sign = this.generateSign(timestamp, webhookSecret);
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(`发送飞书消息失败: ${response.statusText}`);
      }

      logger.info('飞书消息发送成功');
    } catch (error) {
      logger.error('发送飞书消息失败:', error);
      throw error;
    }
  }

  /**
   * 发送工单创建通知
   * @param issueTitle 工单标题
   * @param issueUrl 工单链接
   * @param assigneeUsernames 被指派人用户名列表
   */
  async sendIssueCreatedNotification(
    issueTitle: string,
    issueUrl: string,
    assigneeUsernames: string[]
  ): Promise<void> {
    const content = `📝 新工单已创建\n标题: ${issueTitle}\n链接: ${issueUrl}`;
    await this.sendMessage(content, assigneeUsernames);
  }

  /**
   * 发送工单关闭通知
   * @param issueTitle 工单标题
   * @param issueUrl 工单链接
   * @param creatorUsername 创建者用户名
   */
  async sendIssueClosedNotification(
    issueTitle: string,
    issueUrl: string,
    creatorUsername: string
  ): Promise<void> {
    const content = `✅ 工单已关闭\n标题: ${issueTitle}\n链接: ${issueUrl}`;
    await this.sendMessage(content, [creatorUsername]);
  }

  /**
   * 发送工单指派通知
   * @param issueTitle 工单标题
   * @param issueUrl 工单链接
   * @param assigneeUsernames 被指派人用户名列表
   */
  async sendIssueAssignedNotification(
    issueTitle: string,
    issueUrl: string,
    assigneeUsernames: string[]
  ): Promise<void> {
    const content = `👤 工单已指派给你\n标题: ${issueTitle}\n链接: ${issueUrl}`;
    await this.sendMessage(content, assigneeUsernames);
  }

  /**
   * 发送PR创建通知给审阅者
   * @param prTitle PR标题
   * @param prUrl PR链接
   * @param reviewerUsernames 审阅者用户名列表
   */
  async sendPrCreatedNotification(
    prTitle: string,
    prUrl: string,
    reviewerUsernames: string[]
  ): Promise<void> {
    const content = `🔄 新PR等待你审阅\n标题: ${prTitle}\n链接: ${prUrl}`;
    await this.sendMessage(content, reviewerUsernames);
  }

  /**
   * 发送PR指派审阅者通知
   * @param prTitle PR标题
   * @param prUrl PR链接
   * @param reviewerUsernames 审阅者用户名列表
   */
  async sendPrReviewerAssignedNotification(
    prTitle: string,
    prUrl: string,
    reviewerUsernames: string[]
  ): Promise<void> {
    const content = `👀 你被指定为PR审阅者\n标题: ${prTitle}\n链接: ${prUrl}`;
    await this.sendMessage(content, reviewerUsernames);
  }
}

export const feishuService = new FeishuService();
