import type {
  INotificationService,
  NotificationServiceConfig,
} from './types.js';
import { FeishuNotificationService } from './providers/feishu-notification-service.js';
import { WeComNotificationService } from './providers/wecom-notification-service.js';

export class NotificationFactory {
  static createService(config: NotificationServiceConfig): INotificationService {
    switch (config.provider) {
      case 'feishu':
        return new FeishuNotificationService(config);
      case 'wecom':
        return new WeComNotificationService(config);
      default:
        throw new Error(`Unknown notification provider: ${config.provider}`);
    }
  }

  static createServices(configs: NotificationServiceConfig[]): INotificationService[] {
    return configs
      .filter((c) => c.enabled && c.webhookUrl)
      .map((c) => this.createService(c));
  }
}
