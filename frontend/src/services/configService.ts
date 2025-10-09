import api from '@/lib/api';

export interface ConfigItem {
  value: any;
  description: string;
  requiresRestart: boolean;
  hasEnvOverride: boolean;
}

export interface ConfigGroup {
  title: string;
  description: string;
  configs: Record<string, ConfigItem>;
}

export interface ConfigData {
  grouped: Record<string, ConfigGroup>;
  all: Record<string, ConfigItem>;
}

export interface ConfigValidationResult {
  valid: boolean;
  error?: string;
}

export const configService = {
  // 获取所有配置
  async getConfigs(): Promise<ConfigData> {
    const response = await api.get('/config');
    return response.data.data;
  },

  // 更新单个配置
  async updateConfig(key: string, value: any): Promise<void> {
    await api.put(`/config/${key}`, { value });
  },

  // 批量更新配置
  async batchUpdateConfigs(configs: Record<string, any>): Promise<void> {
    await api.put('/config', { configs });
  },

  // 验证配置值
  async validateConfig(key: string, value: any): Promise<ConfigValidationResult> {
    const response = await api.post('/config/validate', { key, value });
    return response.data;
  },

  // 获取配置元数据
  async getConfigMetadata(): Promise<any> {
    const response = await api.get('/config/metadata');
    return response.data.data;
  }
};