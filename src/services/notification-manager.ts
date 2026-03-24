import { createNotificationManager, type NotificationManager } from './notification/notification-manager.js';
import { getNotificationConfigs } from '../config/index.js';

export function getNotificationManager(): NotificationManager {
  const configs = getNotificationConfigs();
  return createNotificationManager(configs);
}

export function resetNotificationManager(): void {
  return;
}
