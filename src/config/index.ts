import { config } from 'dotenv';
import { z } from 'zod';

// 加载环境变量
config();

// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

// 环境变量验证模式
const envSchema = z.object({
  // Gitea配置
  GITEA_API_URL: z.string().url().default('http://localhost:5174/api/v1'),
  GITEA_ACCESS_TOKEN: z.string().default('test_token'),
  GITEA_ADMIN_TOKEN: z.string().optional(),

  // OpenAI配置
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().default('test_openai_key'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  CUSTOM_SUMMARY_PROMPT: z.string().optional(),
  CUSTOM_LINE_COMMENT_PROMPT: z.string().optional(),

  // 飞书配置
  FEISHU_WEBHOOK_URL: z.string().url(),
  FEISHU_WEBHOOK_SECRET: z.string().optional(),

  // 应用配置
  PORT: z.string().transform(Number).default('5174'),
  BASE_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().default('test_webhook_secret'),

  // 管理后台配置
  ADMIN_PASSWORD: z.string().default('password'),
  JWT_SECRET: z.string().default('a-secure-secret-for-jwt'),
});

// 处理验证结果
const envParseResult = envSchema.safeParse(process.env);

if (!envParseResult.success) {
  console.error('❌ 环境变量验证失败:');
  console.error(envParseResult.error.format());

  if (isDev) {
    console.warn('⚠️ 使用开发环境默认值');
  } else {
    throw new Error('环境变量配置错误');
  }
}

// 导出配置
export default {
  gitea: {
    apiUrl: envParseResult.success ? envParseResult.data.GITEA_API_URL : 'http://localhost:5174/api/v1',
    accessToken: envParseResult.success ? envParseResult.data.GITEA_ACCESS_TOKEN : 'test_token',
  },
  openai: {
    baseUrl: envParseResult.success ? envParseResult.data.OPENAI_BASE_URL : 'https://api.openai.com/v1',
    apiKey: envParseResult.success ? envParseResult.data.OPENAI_API_KEY : 'test_openai_key',
    model: envParseResult.success ? envParseResult.data.OPENAI_MODEL : 'gpt-4o-mini',
    customSummaryPrompt: envParseResult.success ? envParseResult.data.CUSTOM_SUMMARY_PROMPT : undefined,
    customLineCommentPrompt: envParseResult.success ? envParseResult.data.CUSTOM_LINE_COMMENT_PROMPT : undefined,
  },
  feishu: {
    webhookUrl: envParseResult.success ? envParseResult.data.FEISHU_WEBHOOK_URL : '',
    webhookSecret: envParseResult.success ? envParseResult.data.FEISHU_WEBHOOK_SECRET : '',
  },
  app: {
    port: envParseResult.success ? envParseResult.data.PORT : 5174,
    baseUrl: envParseResult.success ? envParseResult.data.BASE_URL : undefined,
    webhookSecret: envParseResult.success ? envParseResult.data.WEBHOOK_SECRET : 'test_webhook_secret',
  },
  admin: {
    password: envParseResult.success ? envParseResult.data.ADMIN_PASSWORD : 'password',
    jwtSecret: envParseResult.success ? envParseResult.data.JWT_SECRET : 'a-secure-secret-for-jwt',
    giteaAdminToken: envParseResult.success ? envParseResult.data.GITEA_ADMIN_TOKEN : undefined,
  },
};
