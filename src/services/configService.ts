import { CONFIG_METADATA, ConfigMetadata } from '@/types/config';
import { logger } from '@/utils/logger';
import path from 'path';
import fs from 'fs';

interface ConfigRow {
  key: string;
  value: string;
  type: string;
  description: string;
  sensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

export class ConfigService {
  private configFile: string;
  private static instance: ConfigService;

  constructor() {
    // 确保数据目录存在
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.configFile = path.join(dataDir, 'config.json');
    this.initConfigFile();
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  private initConfigFile(): void {
    if (!fs.existsSync(this.configFile)) {
      fs.writeFileSync(this.configFile, JSON.stringify({}));
    }
    logger.info('Config file initialized');
  }

  /**
   * 获取配置值（优先级：JSON文件 > ENV > 默认值）
   */
  async getConfig(key: string): Promise<any> {
    const meta = CONFIG_METADATA[key];
    if (!meta) {
      // 未定义的配置，直接从环境变量读取
      return process.env[key];
    }

    switch (meta.category) {
      case 'ui-manageable':
        // UI可管理配置：JSON文件 > ENV > 默认值
        const fileValue = await this.getFromFile(key);
        if (fileValue !== null) {
          return fileValue;
        }
        return process.env[key] || meta.defaultValue;

      case 'runtime-fixed':
      case 'security-only':
        // 运行时固定或安全配置：ENV > 默认值
        return process.env[key] || meta.defaultValue;

      default:
        return process.env[key] || meta.defaultValue;
    }
  }

  /**
   * 获取UI可管理的配置列表
   */
  async getUIManageableConfigs(): Promise<Record<string, any>> {
    const result: Record<string, any> = {};

    for (const [key, meta] of Object.entries(CONFIG_METADATA)) {
      if (meta.category === 'ui-manageable') {
        result[key] = {
          value: await this.getConfig(key),
          description: meta.description,
          requiresRestart: meta.requiresRestart,
          hasEnvOverride: !!process.env[key] // 标识是否有环境变量覆盖
        };
      }
    }

    return result;
  }

  /**
   * 更新配置（仅允许ui-manageable类型）
   */
  async updateConfig(key: string, value: any, changedBy: string = 'admin'): Promise<void> {
    const meta = CONFIG_METADATA[key];

    if (!meta || meta.category !== 'ui-manageable') {
      throw new Error(`配置 ${key} 不允许通过界面修改`);
    }

    // 验证配置值
    if (meta.validation && !meta.validation(value)) {
      throw new Error(`配置 ${key} 的值无效`);
    }

    // 保存到文件
    await this.saveToFile(key, value, meta);
  }

  /**
   * 批量更新配置
   */
  async batchUpdateConfigs(configs: Record<string, any>, changedBy: string = 'admin'): Promise<void> {
    for (const [key, value] of Object.entries(configs)) {
      await this.updateConfig(key, value, changedBy);
    }
  }

  /**
   * 验证配置有效性
   */
  async validateConfig(key: string, value: any): Promise<{ valid: boolean; error?: string }> {
    const meta = CONFIG_METADATA[key];

    if (!meta) {
      return { valid: false, error: '未知的配置项' };
    }

    if (meta.category !== 'ui-manageable') {
      return { valid: false, error: '此配置不允许通过界面修改' };
    }

    if (meta.validation && !meta.validation(value)) {
      return { valid: false, error: '配置值格式无效' };
    }

    return { valid: true };
  }

  /**
   * 获取配置元数据
   */
  getConfigMetadata(key: string): ConfigMetadata | undefined {
    return CONFIG_METADATA[key];
  }

  /**
   * 获取所有配置元数据（按分组）
   */
  getAllConfigMetadata(): Record<string, ConfigMetadata[]> {
    const grouped: Record<string, ConfigMetadata[]> = {};

    for (const meta of Object.values(CONFIG_METADATA)) {
      if (!grouped[meta.category]) {
        grouped[meta.category] = [];
      }
      grouped[meta.category].push(meta);
    }

    return grouped;
  }

  private async getFromFile(key: string): Promise<any> {
    try {
      const data = fs.readFileSync(this.configFile, 'utf8');
      const config = JSON.parse(data);
      return config[key] || null;
    } catch {
      return null;
    }
  }

  private async saveToFile(key: string, value: any, meta: ConfigMetadata): Promise<void> {
    try {
      let config = {};
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf8');
        config = JSON.parse(data);
      }

      config[key] = value;
      fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (error) {
      logger.error('Failed to save config to file:', error);
      throw new Error('保存配置失败');
    }
  }
}

// 导出单例实例
export const configService = ConfigService.getInstance();