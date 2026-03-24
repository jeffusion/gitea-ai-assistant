import { getNotificationConfigs } from '../config/index.js';
import {
  type NotificationManager,
  createNotificationManager,
} from './notification/notification-manager.js';

export function getNotificationManager(): NotificationManager {
  const configs = getNotificationConfigs();
  return createNotificationManager(configs);
}

export function resetNotificationManager(): void {
  return;
}
