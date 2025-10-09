export interface ConfigMetadata {
  key: string;
  category: 'ui-manageable' | 'runtime-fixed' | 'security-only';
  description: string;
  requiresRestart: boolean;
  sensitive: boolean;
  defaultValue?: any;
  validation?: (value: any) => boolean;
}

export const CONFIG_METADATA: Record<string, ConfigMetadata> = {
  // UI可管理配置 - SQLite > ENV > 默认值
  'BASE_URL': {
    key: 'BASE_URL',
    category: 'ui-manageable',
    description: '应用访问基础URL（用于生成Webhook地址）',
    requiresRestart: false,
    sensitive: false,
    validation: (value: string) => {
      try {
        // tslint:disable-next-line:no-unused-expression
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }
  },
  'GITEA_API_URL': {
    key: 'GITEA_API_URL',
    category: 'ui-manageable',
    description: 'Gitea API地址',
    requiresRestart: false,
    sensitive: false,
    defaultValue: 'http://localhost:3000/api/v1',
    validation: (value: string) => {
      try {
        const url = new URL(value);
        // tslint:disable-next-line:no-unused-expression
        url.pathname.includes('/api/v1');
        return url.pathname.includes('/api/v1');
      } catch {
        return false;
      }
    }
  },
  'OPENAI_BASE_URL': {
    key: 'OPENAI_BASE_URL',
    category: 'ui-manageable',
    description: 'OpenAI API基础URL',
    requiresRestart: false,
    sensitive: false,
    defaultValue: 'https://api.openai.com/v1',
    validation: (value: string) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }
  },
  'OPENAI_MODEL': {
    key: 'OPENAI_MODEL',
    category: 'ui-manageable',
    description: 'OpenAI模型名称',
    requiresRestart: false,
    sensitive: false,
    defaultValue: 'gpt-4o-mini'
  },
  'CUSTOM_SUMMARY_PROMPT': {
    key: 'CUSTOM_SUMMARY_PROMPT',
    category: 'ui-manageable',
    description: '自定义摘要提示词模板',
    requiresRestart: false,
    sensitive: false
  },
  'CUSTOM_LINE_COMMENT_PROMPT': {
    key: 'CUSTOM_LINE_COMMENT_PROMPT',
    category: 'ui-manageable',
    description: '自定义行评论提示词模板',
    requiresRestart: false,
    sensitive: false
  },
  'FEISHU_WEBHOOK_URL': {
    key: 'FEISHU_WEBHOOK_URL',
    category: 'ui-manageable',
    description: '飞书机器人Webhook地址',
    requiresRestart: false,
    sensitive: false,
    validation: (value: string) => {
      try {
        const url = new URL(value);
        return url.hostname.includes('feishu') || url.hostname.includes('lark');
      } catch {
        return false;
      }
    }
  },

  // 运行时固定配置 - ENV > 默认值 (不允许UI修改)
  'PORT': {
    key: 'PORT',
    category: 'runtime-fixed',
    description: '应用监听端口',
    requiresRestart: true,
    sensitive: false,
    defaultValue: 5174
  },
  'NODE_ENV': {
    key: 'NODE_ENV',
    category: 'runtime-fixed',
    description: '运行环境',
    requiresRestart: true,
    sensitive: false,
    defaultValue: 'development'
  },

  // 安全配置 - 仅ENV (不在UI显示)
  'OPENAI_API_KEY': {
    key: 'OPENAI_API_KEY',
    category: 'security-only',
    description: 'OpenAI API密钥',
    requiresRestart: false,
    sensitive: true
  },
  'GITEA_ACCESS_TOKEN': {
    key: 'GITEA_ACCESS_TOKEN',
    category: 'security-only',
    description: 'Gitea访问令牌',
    requiresRestart: false,
    sensitive: true
  },
  'GITEA_ADMIN_TOKEN': {
    key: 'GITEA_ADMIN_TOKEN',
    category: 'security-only',
    description: 'Gitea管理员令牌',
    requiresRestart: false,
    sensitive: true
  },
  'JWT_SECRET': {
    key: 'JWT_SECRET',
    category: 'security-only',
    description: 'JWT签名密钥',
    requiresRestart: false,
    sensitive: true
  },
  'WEBHOOK_SECRET': {
    key: 'WEBHOOK_SECRET',
    category: 'security-only',
    description: 'Webhook验证密钥',
    requiresRestart: false,
    sensitive: true
  },
  'FEISHU_WEBHOOK_SECRET': {
    key: 'FEISHU_WEBHOOK_SECRET',
    category: 'security-only',
    description: '飞书Webhook签名密钥',
    requiresRestart: false,
    sensitive: true
  },
  'ADMIN_PASSWORD': {
    key: 'ADMIN_PASSWORD',
    category: 'security-only',
    description: '管理员登录密码',
    requiresRestart: false,
    sensitive: true
  }
};

export const CONFIG_GROUPS = {
  'basic': {
    title: '基础配置',
    description: '应用基础设置',
    configs: ['BASE_URL']
  },
  'gitea': {
    title: 'Gitea集成',
    description: 'Gitea平台连接配置',
    configs: ['GITEA_API_URL']
  },
  'ai': {
    title: 'AI服务',
    description: 'OpenAI API相关配置',
    configs: ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'CUSTOM_SUMMARY_PROMPT', 'CUSTOM_LINE_COMMENT_PROMPT']
  },
  'notification': {
    title: '通知配置',
    description: '消息推送和通知设置',
    configs: ['FEISHU_WEBHOOK_URL']
  }
};