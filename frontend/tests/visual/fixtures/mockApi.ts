import type { Page, Route } from '@playwright/test';

const repositories = {
  data: [
    {
      name: 'demo-repo-1',
      webhook_status: 'active',
      hook_id: 101,
      project_review_prompt: '重点检查 API 错误处理与鉴权边界。',
    },
    {
      name: 'demo-repo-2',
      webhook_status: 'inactive',
      hook_id: null,
      project_review_prompt: null,
    },
  ],
  totalCount: 2,
  page: 1,
  limit: 30,
};

const configResponse = {
  groups: [
    {
      key: 'gitea',
      label: 'Gitea 连接',
      description: '配置 Gitea 服务地址和访问凭据。',
      icon: 'git-branch',
      fields: [
        {
          envKey: 'GITEA_BASE_URL',
          label: 'Gitea 地址',
          description: 'Gitea API 根地址',
          type: 'url',
          sensitive: false,
          value: 'https://gitea.example.com',
          hasValue: true,
          source: 'db',
        },
      ],
    },
    {
      key: 'notification',
      label: '通知服务',
      description: '配置飞书与企业微信通知。',
      icon: 'bell',
      fields: [
        {
          envKey: 'FEISHU_ENABLED',
          label: '启用飞书通知',
          description: '是否启用飞书通知',
          type: 'boolean',
          sensitive: false,
          value: true,
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'FEISHU_WEBHOOK_URL',
          label: '飞书 Webhook URL',
          description: '用于发送飞书通知',
          type: 'url',
          sensitive: false,
          value: 'https://open.feishu.cn/mock/webhook',
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'WECOM_ENABLED',
          label: '启用企业微信通知',
          description: '是否启用企业微信通知',
          type: 'boolean',
          sensitive: false,
          value: false,
          hasValue: true,
          source: 'db',
        },
      ],
    },
    {
      key: 'security',
      label: '安全设置',
      description: '控制签名校验与访问策略。',
      icon: 'shield',
      fields: [
        {
          envKey: 'ENABLE_SIGNATURE_VERIFY',
          label: '启用签名校验',
          description: '是否开启 webhook 签名验证',
          type: 'boolean',
          sensitive: false,
          value: true,
          hasValue: true,
          source: 'db',
        },
      ],
    },
    {
      key: 'review',
      label: '审查设置',
      description: '控制审查引擎与执行策略。',
      icon: 'search',
      fields: [
        {
          envKey: 'REVIEW_ENGINE',
          label: '审查引擎',
          description: '当前使用的审查引擎',
          type: 'enum',
          enumValues: ['agent', 'codex'],
          sensitive: false,
          value: 'agent',
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'GLOBAL_PROMPT',
          label: '全局提示词',
          description: '审查上下文提示词模板',
          type: 'text',
          sensitive: false,
          value: 'Review with focus on correctness and maintainability.',
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'REVIEW_WORKDIR',
          label: '审查工作目录',
          description: '任务执行工作目录',
          type: 'string',
          sensitive: false,
          value: '/tmp/review-workdir',
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'REVIEW_MAX_PARALLEL_RUNS',
          label: '最大并发任务',
          description: '控制并发执行数量',
          type: 'number',
          sensitive: false,
          value: 4,
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'REVIEW_MAX_FILES_PER_RUN',
          label: '单次最大文件数',
          description: '每轮审查最大文件数',
          type: 'number',
          sensitive: false,
          value: 40,
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'REVIEW_MAX_FILE_CONTENT_CHARS',
          label: '单文件最大字符',
          description: '单文件读取上限',
          type: 'number',
          sensitive: false,
          value: 20000,
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'LLM_MAX_CONCURRENT_CALLS',
          label: 'LLM 并发调用数',
          description: '限制并发调用',
          type: 'number',
          sensitive: false,
          value: 4,
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'CODEX_MODEL',
          label: 'Codex 模型',
          description: 'Codex 模式默认模型',
          type: 'string',
          sensitive: false,
          value: 'gpt-4o-mini',
          hasValue: true,
          source: 'db',
        },
        {
          envKey: 'CODEX_API_URL',
          label: 'Codex API 地址',
          description: 'Codex 服务地址',
          type: 'url',
          sensitive: false,
          value: 'https://api.openai.com/v1',
          hasValue: true,
          source: 'db',
        },
      ],
    },
  ],
};

const providers = [
  {
    id: 'provider-openai',
    name: 'OpenAI',
    type: 'openai_responses',
    baseUrl: null,
    defaultModel: 'gpt-4o-mini',
    isEnabled: true,
    hasKey: true,
    extraConfig: {},
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
  },
  {
    id: 'provider-deepseek',
    name: 'DeepSeek',
    type: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    isEnabled: true,
    hasKey: true,
    extraConfig: {},
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
  },
];

const modelSuggestions = {
  openai_compatible: ['deepseek-chat', 'gpt-4o-mini'],
  openai_responses: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4-20250514'],
  gemini: ['gemini-2.5-pro'],
};

const notificationTestHistory = [
  {
    id: 'test-1',
    provider: 'feishu',
    status: 'success',
    message: 'feishu 测试通知已发送',
    timestamp: '2026-03-24T09:00:00.000Z',
  },
  {
    id: 'test-2',
    provider: 'wecom',
    status: 'error',
    message: 'wecom 未启用或未配置',
    timestamp: '2026-03-24T08:50:00.000Z',
  },
];

const json = async (route: Route, body: unknown, status = 200) => {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
};

export async function installVisualApiMocks(page: Page) {
  await page.route('**/admin/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (method === 'POST' && path.endsWith('/admin/api/login')) {
      return json(route, { token: 'visual-token' });
    }

    if (method === 'GET' && path.endsWith('/admin/api/repositories')) {
      return json(route, repositories);
    }

    if (method === 'POST' && /\/admin\/api\/repositories\/[^/]+(?:\/[^/]+)?\/webhook$/.test(path)) {
      return json(route, { hook_id: 101, webhook_status: 'active' });
    }

    if (
      method === 'DELETE' &&
      /\/admin\/api\/repositories\/[^/]+(?:\/[^/]+)?\/webhook\/\d+$/.test(path)
    ) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (
      method === 'PUT' &&
      /\/admin\/api\/repositories\/[^/]+(?:\/[^/]+)?\/project-prompt$/.test(path)
    ) {
      return json(route, {
        success: true,
        project_review_prompt: 'updated prompt',
      });
    }

    if (method === 'GET' && path.endsWith('/admin/api/config')) {
      return json(route, configResponse);
    }

    if (method === 'PUT' && path.endsWith('/admin/api/config')) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'POST' && path.endsWith('/admin/api/config/reset')) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'POST' && path.endsWith('/admin/api/config/notification/test')) {
      return json(route, { success: true, message: 'test sent' });
    }

    if (method === 'GET' && path.endsWith('/admin/api/config/notification/test/history')) {
      return json(route, { data: notificationTestHistory });
    }

    if (method === 'GET' && path.endsWith('/admin/api/llm/model-suggestions')) {
      return json(route, modelSuggestions);
    }

    if (method === 'GET' && path.endsWith('/admin/api/llm/providers')) {
      return json(route, providers);
    }

    if (method === 'POST' && path.endsWith('/admin/api/llm/providers')) {
      return json(route, providers[0]);
    }

    if (method === 'PUT' && /\/admin\/api\/llm\/providers\/[^/]+$/.test(path)) {
      return json(route, providers[0]);
    }

    if (method === 'DELETE' && /\/admin\/api\/llm\/providers\/[^/]+$/.test(path)) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'PUT' && /\/admin\/api\/llm\/providers\/[^/]+\/key$/.test(path)) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'DELETE' && /\/admin\/api\/llm\/providers\/[^/]+\/key$/.test(path)) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'POST' && /\/admin\/api\/llm\/providers\/[^/]+\/test$/.test(path)) {
      return json(route, {
        success: true,
        latencyMs: 154,
        model: 'gpt-4o-mini',
        message: 'Test connection success',
      });
    }

    return json(
      route,
      {
        error: `Unhandled visual mock request: ${method} ${path}`,
      },
      501
    );
  });
}
