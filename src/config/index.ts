import { configManager } from './config-manager.js';
import type { NotificationServiceConfig } from '../services/notification/types.js';

type AppConfig = import('./config-manager.js').AppConfig;

const config = new Proxy({} as AppConfig, {
  get(_target, prop) {
    return configManager.getCurrent()[prop as keyof AppConfig];
  },
});

export function getNotificationConfigs(): NotificationServiceConfig[] {
  const current = configManager.getCurrent();
  const configs: NotificationServiceConfig[] = [];

  if (current.notification.feishu.enabled && current.notification.feishu.webhookUrl) {
    configs.push({
      provider: 'feishu',
      enabled: true,
      webhookUrl: current.notification.feishu.webhookUrl,
      webhookSecret: current.notification.feishu.webhookSecret,
    });
  }

  if (current.notification.wecom.enabled && current.notification.wecom.webhookUrl) {
    configs.push({
      provider: 'wecom',
      enabled: true,
      webhookUrl: current.notification.wecom.webhookUrl,
    });
  }

  return configs;
}

export { configManager };
export default config;
