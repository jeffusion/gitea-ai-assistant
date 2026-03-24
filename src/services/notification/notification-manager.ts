import { logger } from '../../utils/logger.js';
import { createNotificationServices } from './notification-factory.js';
import type {
  INotificationService,
  NotificationContext,
  NotificationMessage,
  NotificationProvider,
} from './types.js';

export class NotificationManager {
  private services: INotificationService[] = [];

  constructor(services: INotificationService[] = []) {
    this.services = services;
  }

  addService(service: INotificationService): void {
    this.services.push(service);
  }

  removeService(provider: NotificationProvider): void {
    this.services = this.services.filter((s) => s.provider !== provider);
  }

  hasService(provider: NotificationProvider): boolean {
    return this.services.some((s) => s.provider === provider && s.isEnabled());
  }

  getService(provider: NotificationProvider): INotificationService | undefined {
    return this.services.find((s) => s.provider === provider);
  }

  getEnabledServices(): INotificationService[] {
    return this.services.filter((s) => s.isEnabled());
  }

  private async broadcast(
    operation: (service: INotificationService) => Promise<void>
  ): Promise<void> {
    const enabledServices = this.getEnabledServices();

    if (enabledServices.length === 0) {
      logger.debug('No notification services enabled');
      return;
    }

    const results = await Promise.allSettled(
      enabledServices.map(async (service) => {
        try {
          await operation(service);
          logger.debug(`${service.provider} notification sent successfully`);
        } catch (error) {
          logger.error(`${service.provider} notification failed:`, error);
          throw error;
        }
      })
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(`${failures.length}/${enabledServices.length} notification services failed`);
    }
  }

  async notifyIssueCreated(context: NotificationContext): Promise<void> {
    await this.broadcast((s) => s.sendIssueCreatedNotification(context));
  }

  async notifyIssueClosed(context: NotificationContext): Promise<void> {
    await this.broadcast((s) => s.sendIssueClosedNotification(context));
  }

  async notifyIssueAssigned(context: NotificationContext): Promise<void> {
    await this.broadcast((s) => s.sendIssueAssignedNotification(context));
  }

  async notifyPrCreated(context: NotificationContext): Promise<void> {
    await this.broadcast((s) => s.sendPrCreatedNotification(context));
  }

  async notifyPrReviewerAssigned(context: NotificationContext): Promise<void> {
    await this.broadcast((s) => s.sendPrReviewerAssignedNotification(context));
  }

  async sendTestMessage(provider: NotificationProvider): Promise<void> {
    const service = this.getService(provider);
    if (!service || !service.isEnabled()) {
      throw new Error(`${provider} notification service is not enabled`);
    }

    const message: NotificationMessage = {
      type: 'text',
      content: `🧪 通知测试消息\n服务: ${provider}\n时间: ${new Date().toISOString()}`,
    };

    await service.sendMessage(message);
  }
}

export function createNotificationManager(
  configs: import('./types.js').NotificationServiceConfig[]
): NotificationManager {
  const services = createNotificationServices(configs);
  return new NotificationManager(services);
}
