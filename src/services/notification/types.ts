export type NotificationProvider = 'feishu' | 'wecom' | 'slack' | 'dingtalk';

export type NotificationMessageType = 'text' | 'markdown';

export interface NotificationContext {
  prTitle?: string;
  prUrl?: string;
  prNumber?: number;
  issueTitle?: string;
  issueUrl?: string;
  issueNumber?: number;
  actor?: string;
  assignees?: string[];
  reviewers?: string[];
  creator?: string;
  repository?: string;
  owner?: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

export interface NotificationMessage {
  type: NotificationMessageType;
  title?: string;
  content: string;
  atUsers?: string[];
  url?: string;
}

export interface NotificationServiceConfig {
  provider: NotificationProvider;
  enabled: boolean;
  webhookUrl: string;
  webhookSecret?: string;
  options?: Record<string, unknown>;
}

export interface INotificationService {
  readonly provider: NotificationProvider;
  isEnabled(): boolean;
  sendMessage(message: NotificationMessage): Promise<void>;
  sendIssueCreatedNotification(context: NotificationContext): Promise<void>;
  sendIssueClosedNotification(context: NotificationContext): Promise<void>;
  sendIssueAssignedNotification(context: NotificationContext): Promise<void>;
  sendPrCreatedNotification(context: NotificationContext): Promise<void>;
  sendPrReviewerAssignedNotification(context: NotificationContext): Promise<void>;
}
