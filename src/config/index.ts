import { config } from 'dotenv';
import { z } from 'zod';

// 加载环境变量
config();

// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
const defaultAllowedReviewCommands = ['git', 'rg', 'cat', 'sed', 'wc'];

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
  WEBHOOK_SECRET: z.string().default('test_webhook_secret'),

  // 管理后台配置
  ADMIN_PASSWORD: z.string().default('password'),
  JWT_SECRET: z.string().default('a-secure-secret-for-jwt'),

  // Agent审查配置
  REVIEW_ENGINE: z.enum(['legacy', 'agent']).default('legacy'),
  REVIEW_WORKDIR: z.string().default('/tmp/gitea-assistant'),
  REVIEW_MODEL_PLANNER: z.string().default('gpt-4o-mini'),
  REVIEW_MODEL_SPECIALIST: z.string().default('gpt-4o-mini'),
  REVIEW_MODEL_JUDGE: z.string().default('gpt-4o-mini'),
  REVIEW_MAX_PARALLEL_RUNS: z.coerce.number().int().min(1).max(8).default(2),
  REVIEW_MAX_FILES_PER_RUN: z.coerce.number().int().min(1).max(1000).default(200),
  REVIEW_MAX_FILE_CONTENT_CHARS: z.coerce.number().int().min(1000).max(1_000_000).default(40_000),
  REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  REVIEW_ENABLE_HUMAN_GATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  REVIEW_ALLOWED_COMMANDS: z.string().default(defaultAllowedReviewCommands.join(',')),
  REVIEW_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(10000),

  // 向量记忆和学习系统配置
  QDRANT_URL: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().url().optional()
  ),
  ENABLE_MEMORY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  FEW_SHOT_EXAMPLES_COUNT: z.coerce.number().int().min(0).max(20).default(10),

  // Reflection和Debate配置（第三阶段）
  ENABLE_REFLECTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAX_REFLECTION_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),
  ENABLE_DEBATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DEBATE_THRESHOLD: z.enum(['high', 'medium']).default('high'),
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
    webhookSecret: envParseResult.success ? envParseResult.data.WEBHOOK_SECRET : 'test_webhook_secret',
  },
  admin: {
    password: envParseResult.success ? envParseResult.data.ADMIN_PASSWORD : 'password',
    jwtSecret: envParseResult.success ? envParseResult.data.JWT_SECRET : 'a-secure-secret-for-jwt',
    giteaAdminToken: envParseResult.success ? envParseResult.data.GITEA_ADMIN_TOKEN : undefined,
  },
  review: {
    engine: envParseResult.success ? envParseResult.data.REVIEW_ENGINE : 'legacy',
    workdir: envParseResult.success ? envParseResult.data.REVIEW_WORKDIR : '/tmp/gitea-assistant',
    modelPlanner: envParseResult.success ? envParseResult.data.REVIEW_MODEL_PLANNER : 'gpt-4o-mini',
    modelSpecialist: envParseResult.success ? envParseResult.data.REVIEW_MODEL_SPECIALIST : 'gpt-4o-mini',
    modelJudge: envParseResult.success ? envParseResult.data.REVIEW_MODEL_JUDGE : 'gpt-4o-mini',
    maxParallelRuns: envParseResult.success ? envParseResult.data.REVIEW_MAX_PARALLEL_RUNS : 2,
    maxFilesPerRun: envParseResult.success ? envParseResult.data.REVIEW_MAX_FILES_PER_RUN : 200,
    maxFileContentChars: envParseResult.success ? envParseResult.data.REVIEW_MAX_FILE_CONTENT_CHARS : 40_000,
    autoPublishMinConfidence: envParseResult.success
      ? envParseResult.data.REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE
      : 0.8,
    enableHumanGate: envParseResult.success ? envParseResult.data.REVIEW_ENABLE_HUMAN_GATE : true,
    allowedCommands: envParseResult.success
      ? envParseResult.data.REVIEW_ALLOWED_COMMANDS.split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      : defaultAllowedReviewCommands,
    commandTimeoutMs: envParseResult.success ? envParseResult.data.REVIEW_COMMAND_TIMEOUT_MS : 10000,
    qdrantUrl: envParseResult.success ? envParseResult.data.QDRANT_URL : undefined,
    enableMemory: envParseResult.success ? envParseResult.data.ENABLE_MEMORY : false,
    fewShotExamplesCount: envParseResult.success ? envParseResult.data.FEW_SHOT_EXAMPLES_COUNT : 10,
    enableReflection: envParseResult.success ? envParseResult.data.ENABLE_REFLECTION : false,
    maxReflectionRounds: envParseResult.success ? envParseResult.data.MAX_REFLECTION_ROUNDS : 2,
    enableDebate: envParseResult.success ? envParseResult.data.ENABLE_DEBATE : false,
    debateThreshold: envParseResult.success ? envParseResult.data.DEBATE_THRESHOLD : 'high',
  },
};
