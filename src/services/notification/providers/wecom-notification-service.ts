import { BaseNotificationService } from '../base-notification-service.js';
import type {
  NotificationContext,
  NotificationMessage,
  NotificationServiceConfig,
} from '../types.js';

type WeComApiResponse = {
  errcode?: number;
  errmsg?: string;
};

export class WeComNotificationService extends BaseNotificationService {
  readonly provider = 'wecom' as const;

  constructor(config: NotificationServiceConfig) {
    super(config);
  }

  async sendMessage(message: NotificationMessage): Promise<void> {
    if (!this.config.webhookUrl) {
      throw new Error('WeCom webhook URL is not configured');
    }

    const payload: Record<string, unknown> = {
      msgtype: 'text',
      text: {
        content: message.content,
      },
    };

    if (message.atUsers?.length) {
      const mentionedList = message.atUsers.map((u) => (u.toLowerCase() === 'all' ? '@all' : u));
      Object.assign(payload.text as Record<string, unknown>, {
        mentioned_list: mentionedList,
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
      throw new Error(`Failed to send WeCom message: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as WeComApiResponse;
    if (result.errcode !== 0) {
      throw new Error(`WeCom API error: ${result.errmsg || 'Unknown error'}`);
    }
  }

  protected buildIssueCreatedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `📝 新工单已创建\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}`,
      atUsers: context.assignees,
      url: context.issueUrl,
    };
  }

  protected buildIssueClosedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `✅ 工单已关闭\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}`,
      atUsers: context.creator ? [context.creator] : undefined,
      url: context.issueUrl,
    };
  }

  protected buildIssueAssignedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `👤 工单已指派给你\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}`,
      atUsers: context.assignees,
      url: context.issueUrl,
    };
  }

  protected buildPrCreatedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `🔄 新PR等待你审阅\n标题: ${context.prTitle}\n链接: ${context.prUrl}`,
      atUsers: context.reviewers,
      url: context.prUrl,
    };
  }

  protected buildPrReviewerAssignedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `👀 你被指定为PR审阅者\n标题: ${context.prTitle}\n链接: ${context.prUrl}`,
      atUsers: context.assignees,
      url: context.prUrl,
    };
  }
}
