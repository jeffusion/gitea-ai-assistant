import * as crypto from 'crypto';
import { BaseNotificationService } from '../base-notification-service.js';
import type {
  NotificationContext,
  NotificationMessage,
  NotificationServiceConfig,
} from '../types.js';

type FeishuApiResponse = {
  code?: number;
  msg?: string;
};

function parseFeishuResponse(raw: unknown): FeishuApiResponse {
  if (typeof raw === 'object' && raw !== null) {
    return raw as FeishuApiResponse;
  }
  return {};
}

export class FeishuNotificationService extends BaseNotificationService {
  readonly provider = 'feishu' as const;

  constructor(config: NotificationServiceConfig) {
    super(config);
  }

  async sendMessage(message: NotificationMessage): Promise<void> {
    if (!this.config.webhookUrl) {
      throw new Error('Feishu webhook URL is not configured');
    }

    const payload: Record<string, unknown> = {
      msg_type: 'text',
      content: {
        text: message.content,
      },
    };

    if (this.config.webhookSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      Object.assign(payload, {
        timestamp,
        sign: this.generateSign(timestamp, this.config.webhookSecret),
      });
    }

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Failed to send Feishu message: ${response.status} ${response.statusText}`);
    }

    const result = parseFeishuResponse(await response.json());
    if (result.code !== 0) {
      throw new Error(`Feishu API error: ${result.msg || 'Unknown error'}`);
    }
  }

  private generateSign(timestamp: string, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', stringToSign);
    return hmac.digest('base64');
  }

  protected buildIssueCreatedMessage(context: NotificationContext): NotificationMessage {
    const atPart = context.assignees?.length
      ? `\n${context.assignees.map((u) => `@${u}`).join(' ')}`
      : '';
    return {
      type: 'text',
      content: `📝 新工单已创建\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}${atPart}`,
      atUsers: context.assignees,
      url: context.issueUrl,
    };
  }

  protected buildIssueClosedMessage(context: NotificationContext): NotificationMessage {
    const atPart = context.creator ? `\n@${context.creator}` : '';
    return {
      type: 'text',
      content: `✅ 工单已关闭\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}${atPart}`,
      atUsers: context.creator ? [context.creator] : undefined,
      url: context.issueUrl,
    };
  }

  protected buildIssueAssignedMessage(context: NotificationContext): NotificationMessage {
    const atPart = context.assignees?.length
      ? `\n${context.assignees.map((u) => `@${u}`).join(' ')}`
      : '';
    return {
      type: 'text',
      content: `👤 工单已指派给你\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}${atPart}`,
      atUsers: context.assignees,
      url: context.issueUrl,
    };
  }

  protected buildPrCreatedMessage(context: NotificationContext): NotificationMessage {
    const atPart = context.reviewers?.length
      ? `\n${context.reviewers.map((u) => `@${u}`).join(' ')}`
      : '';
    return {
      type: 'text',
      content: `🔄 新PR等待你审阅\n标题: ${context.prTitle}\n链接: ${context.prUrl}${atPart}`,
      atUsers: context.reviewers,
      url: context.prUrl,
    };
  }

  protected buildPrReviewerAssignedMessage(context: NotificationContext): NotificationMessage {
    const atPart = context.assignees?.length
      ? `\n${context.assignees.map((u) => `@${u}`).join(' ')}`
      : '';
    return {
      type: 'text',
      content: `👀 你被指定为PR审阅者\n标题: ${context.prTitle}\n链接: ${context.prUrl}${atPart}`,
      atUsers: context.assignees,
      url: context.prUrl,
    };
  }
}
