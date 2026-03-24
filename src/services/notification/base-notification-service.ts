import type {
  INotificationService,
  NotificationContext,
  NotificationMessage,
  NotificationServiceConfig,
} from './types.js';

export abstract class BaseNotificationService implements INotificationService {
  abstract readonly provider: import('./types.js').NotificationProvider;

  constructor(protected config: NotificationServiceConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.webhookUrl;
  }

  abstract sendMessage(message: NotificationMessage): Promise<void>;

  async sendIssueCreatedNotification(context: NotificationContext): Promise<void> {
    const message = this.buildIssueCreatedMessage(context);
    await this.sendMessage(message);
  }

  async sendIssueClosedNotification(context: NotificationContext): Promise<void> {
    const message = this.buildIssueClosedMessage(context);
    await this.sendMessage(message);
  }

  async sendIssueAssignedNotification(context: NotificationContext): Promise<void> {
    const message = this.buildIssueAssignedMessage(context);
    await this.sendMessage(message);
  }

  async sendPrCreatedNotification(context: NotificationContext): Promise<void> {
    const message = this.buildPrCreatedMessage(context);
    await this.sendMessage(message);
  }

  async sendPrReviewerAssignedNotification(context: NotificationContext): Promise<void> {
    const message = this.buildPrReviewerAssignedMessage(context);
    await this.sendMessage(message);
  }

  protected abstract buildIssueCreatedMessage(
    context: NotificationContext
  ): NotificationMessage;

  protected abstract buildIssueClosedMessage(
    context: NotificationContext
  ): NotificationMessage;

  protected abstract buildIssueAssignedMessage(
    context: NotificationContext
  ): NotificationMessage;

  protected abstract buildPrCreatedMessage(context: NotificationContext): NotificationMessage;

  protected abstract buildPrReviewerAssignedMessage(
    context: NotificationContext
  ): NotificationMessage;
}
