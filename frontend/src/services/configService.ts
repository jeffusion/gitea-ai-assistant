import api from '@/lib/api';

export type ConfigSource = 'default' | 'db';
export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'url' | 'text' | 'enum';

export interface ConfigFieldDto {
  envKey: string;
  label: string;
  description: string;
  type: ConfigFieldType;
  sensitive: boolean;
  enumValues?: string[];
  min?: number;
  max?: number;
  defaultValue?: string | number | boolean;
  value: string | number | boolean | undefined;
  hasValue: boolean;
  source: ConfigSource;
}

export interface ConfigGroupDto {
  key: string;
  label: string;
  description: string;
  icon: string;
  fields: ConfigFieldDto[];
}

export interface ConfigResponse {
  groups: ConfigGroupDto[];
}

export type NotificationTestProvider = 'feishu' | 'wecom';
export type NotificationTestStatus = 'success' | 'error';

export interface NotificationTestRecordDto {
  id: string;
  provider: string;
  status: NotificationTestStatus;
  message: string;
  timestamp: string;
}

export interface NotificationTestHistoryResponse {
  data: NotificationTestRecordDto[];
}

export const fetchConfig = async (): Promise<ConfigResponse> => {
  const response = await api.get<ConfigResponse>('/config');
  return response.data;
};

export const updateConfig = async (configData: Record<string, string>): Promise<void> => {
  await api.put('/config', configData);
};

export const resetConfig = async (keys: string[]): Promise<void> => {
  await api.post('/config/reset', { keys });
};

export const testNotification = async (provider: NotificationTestProvider): Promise<void> => {
  await api.post('/config/notification/test', { provider });
};

export const fetchNotificationTestHistory = async (): Promise<NotificationTestRecordDto[]> => {
  const response = await api.get<NotificationTestHistoryResponse>('/config/notification/test/history');
  return response.data.data;
};
