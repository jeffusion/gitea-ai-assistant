/**
 * 配置字段元数据定义
 * 纯静态元数据，不读取任何环境变量。供后端 API 和前端 GUI 渲染/编辑配置使用。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigGroup = 'gitea' | 'openai' | 'feishu' | 'app' | 'admin' | 'review' | 'memory';

export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'url' | 'text' | 'enum';

export interface ConfigFieldMeta {
  envKey: string;
  group: ConfigGroup;
  label: string;
  description: string;
  type: ConfigFieldType;
  sensitive: boolean;
  readonly?: boolean;
  readonlyWarning?: string;
  enumValues?: string[];
  min?: number;
  max?: number;
  defaultValue?: string | number | boolean;
}

export interface ConfigGroupMeta {
  key: ConfigGroup;
  label: string;
  description: string;
  icon: string;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const CONFIG_GROUPS: ConfigGroupMeta[] = [
  {
    key: 'gitea',
    label: 'Gitea 连接',
    description: 'Gitea 实例地址与访问令牌',
    icon: 'link',
  },
  {
    key: 'openai',
    label: 'OpenAI / LLM',
    description: 'AI 模型接口与自定义提示词',
    icon: 'bot',
  },
  {
    key: 'feishu',
    label: '飞书通知',
    description: '飞书 Webhook 通知配置',
    icon: 'bell',
  },
  {
    key: 'app',
    label: '应用',
    description: '服务端口与 Webhook 安全',
    icon: 'settings',
  },
  {
    key: 'admin',
    label: '管理后台',
    description: '后台登录密码与 JWT 密钥',
    icon: 'shield',
  },
  {
    key: 'review',
    label: '审查引擎',
    description: 'Agent 审查模式、并发与沙箱设置',
    icon: 'file-check',
  },
  {
    key: 'memory',
    label: '记忆与学习',
    description: '向量记忆、反思与辩论系统',
    icon: 'brain',
  },
];

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export const CONFIG_FIELDS: ConfigFieldMeta[] = [
  // ── Gitea ───────────────────────────────────────────────────────────────
  {
    envKey: 'GITEA_API_URL',
    group: 'gitea',
    label: 'Gitea API 地址',
    description: 'Gitea 实例的 API 根路径',
    type: 'url',
    sensitive: false,
    defaultValue: 'http://localhost:5174/api/v1',
  },
  {
    envKey: 'GITEA_ACCESS_TOKEN',
    group: 'gitea',
    label: '访问令牌',
    description: '用于代码审查的 Gitea 访问令牌（需要仓库读权限和评论权限）',
    type: 'string',
    sensitive: true,
    defaultValue: 'test_token',
  },
  {
    envKey: 'GITEA_ADMIN_TOKEN',
    group: 'gitea',
    label: '管理员令牌',
    description: '用于后台管理的 Gitea 管理员令牌（可选，需要仓库读写及 Webhook 管理权限）',
    type: 'string',
    sensitive: true,
  },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  {
    envKey: 'OPENAI_BASE_URL',
    group: 'openai',
    label: 'API 地址',
    description: 'OpenAI 兼容 API 的基础 URL',
    type: 'url',
    sensitive: false,
    defaultValue: 'https://api.openai.com/v1',
  },
  {
    envKey: 'OPENAI_API_KEY',
    group: 'openai',
    label: 'API 密钥',
    description: 'OpenAI API 密钥',
    type: 'string',
    sensitive: true,
    defaultValue: 'test_openai_key',
  },
  {
    envKey: 'OPENAI_MODEL',
    group: 'openai',
    label: '模型',
    description: '默认使用的 OpenAI 模型名称',
    type: 'string',
    sensitive: false,
    defaultValue: 'gpt-4o-mini',
  },
  {
    envKey: 'CUSTOM_SUMMARY_PROMPT',
    group: 'openai',
    label: '自定义总结提示词',
    description: '覆盖默认的代码审查总结提示词（留空使用内置提示词）',
    type: 'text',
    sensitive: false,
  },
  {
    envKey: 'CUSTOM_LINE_COMMENT_PROMPT',
    group: 'openai',
    label: '自定义行评论提示词',
    description: '覆盖默认的行级评论提示词（留空使用内置提示词）',
    type: 'text',
    sensitive: false,
  },

  // ── 飞书 ────────────────────────────────────────────────────────────────
  {
    envKey: 'FEISHU_WEBHOOK_URL',
    group: 'feishu',
    label: 'Webhook 地址',
    description: '飞书机器人 Webhook URL',
    type: 'url',
    sensitive: false,
  },
  {
    envKey: 'FEISHU_WEBHOOK_SECRET',
    group: 'feishu',
    label: 'Webhook 签名密钥',
    description: '飞书 Webhook 签名密钥（可选）',
    type: 'string',
    sensitive: true,
  },

  // ── 应用 ────────────────────────────────────────────────────────────────
  {
    envKey: 'PORT',
    group: 'app',
    label: '监听端口',
    description: '服务监听的 HTTP 端口号，修改需通过 .env 配置并重启服务',
    type: 'number',
    sensitive: false,
    readonly: true,
    defaultValue: 5174,
  },
  {
    envKey: 'WEBHOOK_SECRET',
    group: 'app',
    label: 'Webhook 密钥',
    description: '用于验证 Gitea Webhook 请求来源的 HMAC 密钥，修改需通过 .env 配置并同步更新 Gitea',
    type: 'string',
    sensitive: true,
    readonly: true,
    defaultValue: 'test_webhook_secret',
  },

  // ── 管理后台 ────────────────────────────────────────────────────────────
  {
    envKey: 'ADMIN_PASSWORD',
    group: 'admin',
    label: '管理员密码',
    description: '后台管理界面的登录密码',
    type: 'string',
    sensitive: true,
    readonlyWarning: '修改后当前登录会话可能失效',
    defaultValue: 'password',
  },
  {
    envKey: 'JWT_SECRET',
    group: 'admin',
    label: 'JWT 密钥',
    description: '用于签发后台登录 Token 的密钥，修改需通过 .env 配置',
    type: 'string',
    sensitive: true,
    readonly: true,
    defaultValue: 'a-secure-secret-for-jwt',
  },

  // ── 审查引擎 ────────────────────────────────────────────────────────────
  {
    envKey: 'REVIEW_ENGINE',
    group: 'review',
    label: '审查引擎',
    description: '代码审查模式：legacy（传统）或 agent（多代理编排）',
    type: 'enum',
    sensitive: false,
    enumValues: ['legacy', 'agent'],
    defaultValue: 'legacy',
  },
  {
    envKey: 'REVIEW_WORKDIR',
    group: 'review',
    label: '工作目录',
    description: 'Agent 模式下本地仓库 mirror/worktree 的工作目录',
    type: 'string',
    sensitive: false,
    defaultValue: '/tmp/gitea-assistant',
  },
  {
    envKey: 'REVIEW_MODEL_PLANNER',
    group: 'review',
    label: '规划模型',
    description: 'Agent 模式下规划阶段使用的模型',
    type: 'string',
    sensitive: false,
    defaultValue: 'gpt-4o-mini',
  },
  {
    envKey: 'REVIEW_MODEL_SPECIALIST',
    group: 'review',
    label: '专家模型',
    description: 'Agent 模式下专家子代理使用的模型',
    type: 'string',
    sensitive: false,
    defaultValue: 'gpt-4o-mini',
  },
  {
    envKey: 'REVIEW_MODEL_JUDGE',
    group: 'review',
    label: '评审模型',
    description: 'Agent 模式下 Judge 聚合阶段使用的模型',
    type: 'string',
    sensitive: false,
    defaultValue: 'gpt-4o-mini',
  },
  {
    envKey: 'REVIEW_MAX_PARALLEL_RUNS',
    group: 'review',
    label: '最大并发数',
    description: '单机同时执行的审查任务上限',
    type: 'number',
    sensitive: false,
    min: 1,
    max: 8,
    defaultValue: 2,
  },
  {
    envKey: 'REVIEW_MAX_FILES_PER_RUN',
    group: 'review',
    label: '单次最大文件数',
    description: '单次审查最多处理的文件数量',
    type: 'number',
    sensitive: false,
    min: 1,
    max: 1000,
    defaultValue: 200,
  },
  {
    envKey: 'REVIEW_MAX_FILE_CONTENT_CHARS',
    group: 'review',
    label: '单文件最大字符数',
    description: '单个文件上下文的最大字符数',
    type: 'number',
    sensitive: false,
    min: 1000,
    max: 1000000,
    defaultValue: 40000,
  },
  {
    envKey: 'REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE',
    group: 'review',
    label: '自动发布置信度',
    description: '自动发布评论所需的最小置信度（0~1）',
    type: 'number',
    sensitive: false,
    min: 0,
    max: 1,
    defaultValue: 0.8,
  },
  {
    envKey: 'REVIEW_ENABLE_HUMAN_GATE',
    group: 'review',
    label: '人工审批',
    description: '是否启用人工审批队列（低置信度评论需人工确认后发布）',
    type: 'boolean',
    sensitive: false,
    defaultValue: true,
  },
  {
    envKey: 'REVIEW_ALLOWED_COMMANDS',
    group: 'review',
    label: '允许命令',
    description: '本地审查沙箱中允许执行的命令白名单（逗号分隔）',
    type: 'string',
    sensitive: false,
    defaultValue: 'git,rg,cat,sed,wc',
  },
  {
    envKey: 'REVIEW_COMMAND_TIMEOUT_MS',
    group: 'review',
    label: '命令超时(ms)',
    description: '单条本地命令的执行超时时间（毫秒）',
    type: 'number',
    sensitive: false,
    min: 1000,
    max: 300000,
    defaultValue: 10000,
  },

  // ── 记忆与学习 ──────────────────────────────────────────────────────────
  {
    envKey: 'QDRANT_URL',
    group: 'memory',
    label: 'Qdrant 地址',
    description: 'Qdrant 向量数据库的连接 URL',
    type: 'url',
    sensitive: false,
  },
  {
    envKey: 'ENABLE_MEMORY',
    group: 'memory',
    label: '启用记忆',
    description: '是否启用向量记忆系统（需配置 Qdrant）',
    type: 'boolean',
    sensitive: false,
    defaultValue: false,
  },
  {
    envKey: 'FEW_SHOT_EXAMPLES_COUNT',
    group: 'memory',
    label: 'Few-shot 示例数',
    description: '检索的 few-shot 示例数量',
    type: 'number',
    sensitive: false,
    min: 0,
    max: 20,
    defaultValue: 10,
  },
  {
    envKey: 'ENABLE_REFLECTION',
    group: 'memory',
    label: '启用反思',
    description: '是否启用审查结果自我反思机制',
    type: 'boolean',
    sensitive: false,
    defaultValue: false,
  },
  {
    envKey: 'MAX_REFLECTION_ROUNDS',
    group: 'memory',
    label: '最大反思轮数',
    description: '反思迭代的最大轮数',
    type: 'number',
    sensitive: false,
    min: 1,
    max: 5,
    defaultValue: 2,
  },
  {
    envKey: 'ENABLE_DEBATE',
    group: 'memory',
    label: '启用辩论',
    description: '是否启用多视角辩论机制',
    type: 'boolean',
    sensitive: false,
    defaultValue: false,
  },
  {
    envKey: 'DEBATE_THRESHOLD',
    group: 'memory',
    label: '辩论阈值',
    description: '触发辩论的严重程度阈值',
    type: 'enum',
    sensitive: false,
    enumValues: ['high', 'medium'],
    defaultValue: 'high',
  },
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

export function getFieldsByGroup(group: ConfigGroup): ConfigFieldMeta[] {
  return CONFIG_FIELDS.filter((f) => f.group === group);
}
