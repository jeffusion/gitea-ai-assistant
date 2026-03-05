# 技术设计文档：可插拔 LLM Provider 架构

> **状态**: Draft  
> **作者**: AI Architect  
> **日期**: 2026-03-04  
> **相关 Issue**: N/A

---

## 目录

- [0. 设计原则](#0-设计原则)
- [1. 目录结构](#1-目录结构新增改动部分)
- [2. 数据库表结构](#2-数据库表结构sqlite-ddl)
- [3. LLM Gateway 核心接口](#3-llm-gateway-核心-typescript-接口)
- [4. Provider Adapter 差异映射](#4-四个-provider-adapter-核心差异映射)
- [5. 后端 REST API 契约](#5-后端-rest-api-契约)
- [6. 密钥安全设计](#6-密钥安全设计)
- [7. 前端配置页设计](#7-前端配置页设计)
- [8. 现有调用点改造清单](#8-现有调用点改造清单)
- [9. 实施阶段建议](#9-实施阶段建议)
- [10. 风险与缓解](#10-风险与缓解)

---

## 0. 设计原则

| 原则 | 说明 |
|---|---|
| **UI-Only 配置** | 所有业务配置仅通过 Web 管理后台设置，不再有环境变量覆盖层（仅保留极少数启动参数如 `PORT`、`WEBHOOK_SECRET`、`DATABASE_PATH`） |
| **4 Provider 并存** | `openai_compatible`（现有兼容格式）、`openai_responses`（Responses API）、`anthropic`（Messages API）、`gemini`（generateContent API） |
| **SQLite 持久化** | 使用 `bun:sqlite` 零依赖，单文件 `data/assistant.db` |
| **密钥应用层加密** | API Key 使用 AES-256-GCM 加密后存 DB；主密钥通过环境变量 `ENCRYPTION_KEY` 传入（hex 编码，64 字符 = 32 字节），未设置则拒绝启动 |
| **不做向前兼容** | 旧 JSON 配置文件方案直接废弃，新版本仅支持数据库配置 |

### 开源参考

| 借鉴点 | 参考项目 | 具体模式 |
|---|---|---|
| 接口先行 + provider registry | [Vercel AI SDK](https://github.com/vercel/ai) | `LanguageModelV3` spec-first adapter，版本化接口 |
| Provider transformation 差异映射 | [LiteLLM](https://github.com/BerriAI/litellm) | 每个 provider 独立 `transformation.py`，标准化 error/usage |
| Runtime factory + 多 provider 配置 | [LobeChat](https://github.com/lobehub/lobe-chat) | `createOpenAICompatibleRuntime` 工厂 + 动态 model list |
| 配置驱动多 endpoint | [LibreChat](https://github.com/danny-avila/LibreChat) | `librechat.yaml` Custom Endpoints 模式 |
| 能力声明/能力检测 | [Continue](https://github.com/continuedev/continue) | `supportsTools` / `supportsImages` 声明式 capability |

---

## 1. 目录结构（新增/改动部分）

```
src/
├── db/
│   ├── database.ts              # bun:sqlite 初始化
│   ├── migrations/
│   │   └── 001_init.ts          # 建表 DDL
│   └── repositories/
│       ├── provider-repo.ts     # llm_providers CRUD
│       ├── model-role-repo.ts   # model_role_assignments CRUD
│       ├── secret-repo.ts       # 加密 read/write
│       └── settings-repo.ts     # system_settings KV
│
├── llm/
│   ├── types.ts                 # 统一内部请求/响应类型
│   ├── capabilities.ts          # 能力声明枚举
│   ├── errors.ts                # LLM 层标准化错误
│   ├── gateway.ts               # LLM Gateway 入口（按 provider 路由）
│   ├── tool-converter.ts        # 工具定义 → 各 provider 格式转换
│   └── providers/
│       ├── base.ts              # LLMProvider 抽象接口
│       ├── openai-compatible.ts # 现有兼容格式 adapter
│       ├── openai-responses.ts  # OpenAI Responses API adapter
│       ├── anthropic.ts         # Anthropic Messages API adapter
│       └── gemini.ts            # Gemini generateContent adapter
│
├── crypto/
│   └── secrets.ts               # AES-256-GCM 加解密 + master key 管理
│
├── controllers/
│   └── llm-config.ts            # 新 REST API（替代 config.ts 中 LLM 部分）
│
└── config/
    ├── config-manager.ts        # 精简：只管非 LLM 配置（gitea/feishu/app/admin/review 非模型部分）
    └── config-schema.ts         # 移除 openai group，LLM 配置全部走 DB
```

---

## 2. 数据库表结构（SQLite DDL）

### 2.1 ER 关系

```
llm_providers  1 ←──── 1  llm_secrets              (每个 provider 一个加密 key)
llm_providers  1 ←──── N  model_role_assignments    (一个 provider 可服务多个角色)
```

### 2.2 完整 DDL

```sql
-- ============================================================
-- 表1: llm_providers — Provider 实例配置
-- ============================================================
CREATE TABLE llm_providers (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name          TEXT NOT NULL,                    -- 用户自定义显示名，如 "公司内部 OpenAI 代理"
  type          TEXT NOT NULL CHECK (type IN (
                  'openai_compatible',             -- 现有兼容格式（自定义 baseUrl）
                  'openai_responses',              -- OpenAI 标准 Responses API
                  'anthropic',                     -- Anthropic Messages API
                  'gemini'                         -- Google Gemini generateContent
                )),
  base_url      TEXT,                             -- 可选自定义 endpoint（openai_compatible 必填）
  default_model TEXT NOT NULL,                    -- 此 provider 的默认模型 ID
  is_enabled    INTEGER NOT NULL DEFAULT 1,       -- 0=禁用, 1=启用
  extra_config  TEXT DEFAULT '{}',                -- JSON: provider 特有配置（如 api_version, project_id 等）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 表2: llm_secrets — 加密存储的 API Key
-- ============================================================
CREATE TABLE llm_secrets (
  provider_id   TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
  ciphertext    BLOB NOT NULL,                    -- AES-256-GCM 密文
  iv            BLOB NOT NULL,                    -- 12 bytes nonce
  auth_tag      BLOB NOT NULL,                    -- 16 bytes GCM tag
  key_version   INTEGER NOT NULL DEFAULT 1,       -- 主密钥版本号（便于密钥轮换）
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 表3: model_role_assignments — 场景 → 模型映射
-- ============================================================
-- 每个业务场景（如 planner/specialist/judge/legacy/embedding）绑定到
-- 一个 provider + 具体 model，支持不同场景用不同 provider。
CREATE TABLE model_role_assignments (
  role          TEXT PRIMARY KEY CHECK (role IN (
                  'legacy',          -- 旧版单次审查（ai-review.ts）
                  'planner',         -- Agent 审查 planner
                  'specialist',      -- Agent 审查 specialist
                  'judge',           -- Agent 审查 judge
                  'embedding'        -- 向量嵌入（Qdrant）
                )),
  provider_id   TEXT NOT NULL REFERENCES llm_providers(id),
  model         TEXT NOT NULL,        -- 该场景使用的具体模型 ID
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 表4: system_settings — 通用 KV 设置
-- ============================================================
-- 存放非 LLM 的业务配置（由 UI 直接写入 DB）
CREATE TABLE system_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  is_sensitive  INTEGER NOT NULL DEFAULT 0,       -- 1=加密存储(复用 crypto 模块)
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_providers_type ON llm_providers(type);
CREATE INDEX idx_providers_enabled ON llm_providers(is_enabled);
```

### 2.3 字段说明补充

| 表.字段 | 说明 |
|---|---|
| `llm_providers.type` | 决定使用哪个 adapter 实现 |
| `llm_providers.base_url` | `openai_compatible` 类型必填（用户自建代理地址）；其他类型可选覆盖官方默认 endpoint |
| `llm_providers.extra_config` | JSON 字段，存放 provider 特有参数。例如 Gemini 的 `projectId`、OpenAI 的 `organization`、Anthropic 的 `anthropic-version` header 等 |
| `llm_secrets.key_version` | 用于密钥轮换：当 `ENCRYPTION_KEY` 更新后，启动时批量重加密所有 `key_version < current` 的记录 |
| `model_role_assignments.role` | 业务角色枚举，对应代码中不同调用场景 |
| `system_settings.is_sensitive` | 为 1 时 value 字段存密文（复用 `crypto/secrets.ts`），GET API 返回 masked |

---

## 3. LLM Gateway 核心 TypeScript 接口

### 3.1 统一消息与请求/响应类型

```typescript
// ── src/llm/types.ts ────────────────────────────────────────

/** 模型角色枚举 */
export type ModelRole = 'legacy' | 'planner' | 'specialist' | 'judge' | 'embedding';

/** 统一消息格式（内部表达，不暴露 provider 差异） */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;        // role=tool 时关联的 tool call ID
  toolCalls?: LLMToolCall[];  // role=assistant 时返回的 tool calls
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

/** 工具定义（内部通用格式，由 tool-converter.ts 转为各 provider 格式） */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** 统一请求 */
export interface LLMChatRequest {
  messages: LLMMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';     // 抽象 JSON mode
  tools?: LLMToolDefinition[];
  /** provider 透传配置（如 Anthropic thinking、Gemini safetySettings） */
  providerOptions?: Record<string, unknown>;
}

/** 统一响应 */
export interface LLMChatResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  raw?: unknown; // 保留原始响应供调试
}
```

### 3.2 能力模型

```typescript
// ── src/llm/capabilities.ts ─────────────────────────────────

export interface ProviderCapabilities {
  /** 是否支持 tool/function calling */
  supportsTools: boolean;
  /** 是否支持原生 JSON mode（vs 需要 prompt 指令 + 手动解析） */
  supportsJsonMode: boolean;
  /** 是否支持 SSE streaming */
  supportsStreaming: boolean;
  /** 是否支持 embedding 接口 */
  supportsEmbeddings: boolean;
  /** 是否支持图片/多模态输入 */
  supportsMultimodal: boolean;
  /** 最大输入 token 数（用于预校验，避免无效调用） */
  maxInputTokens?: number;
}

/** 各 provider 默认能力声明 */
export const DEFAULT_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai_compatible: {
    supportsTools: true,
    supportsJsonMode: true,
    supportsStreaming: true,
    supportsEmbeddings: true,
    supportsMultimodal: false, // 取决于具体模型
  },
  openai_responses: {
    supportsTools: true,
    supportsJsonMode: true,
    supportsStreaming: true,
    supportsEmbeddings: true,
    supportsMultimodal: true,
  },
  anthropic: {
    supportsTools: true,
    supportsJsonMode: false, // 无原生 JSON mode，需 prompt 指令
    supportsStreaming: true,
    supportsEmbeddings: false,
    supportsMultimodal: true,
  },
  gemini: {
    supportsTools: true,
    supportsJsonMode: true, // responseMimeType: 'application/json'
    supportsStreaming: true,
    supportsEmbeddings: true,
    supportsMultimodal: true,
  },
};
```

### 3.3 Provider 抽象接口

```typescript
// ── src/llm/providers/base.ts ───────────────────────────────

import type { ProviderCapabilities } from '../capabilities';
import type { LLMChatRequest, LLMChatResponse } from '../types';

export interface LLMProvider {
  /** Provider 类型标识 */
  readonly type: string;

  /** 能力声明 */
  readonly capabilities: ProviderCapabilities;

  /**
   * 核心调用方法。Gateway 只调用此方法。
   * 各 adapter 负责：
   *   1. 将 LLMChatRequest 转为 provider 原生格式
   *   2. 发 HTTP / SDK 调用
   *   3. 将原生响应转为 LLMChatResponse
   */
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;

  /** 可选：嵌入接口 */
  embed?(texts: string[]): Promise<number[][]>;
}

/** Provider 工厂函数签名：从 DB 配置 + 解密后 apiKey 创建实例 */
export type ProviderFactory = (config: {
  baseUrl?: string;
  apiKey: string;
  defaultModel: string;
  extraConfig: Record<string, unknown>;
}) => LLMProvider;
```

### 3.4 Gateway 入口

```typescript
// ── src/llm/gateway.ts ──────────────────────────────────────

import type { ModelRole, LLMChatRequest, LLMChatResponse } from './types';
import type { LLMProvider } from './providers/base';

/**
 * LLM Gateway — 业务层唯一入口
 *
 * 职责：
 *   1. 根据 role 查询 model_role_assignments → provider_id + model
 *   2. 从 provider 缓存获取（或按需创建）LLMProvider 实例
 *   3. 调用 provider.chat() 并返回统一响应
 *   4. 如果 provider 配置变更（UI 保存时），invalidate 缓存
 */
export class LLMGateway {
  /** provider 实例缓存（provider_id → LLMProvider） */
  private cache = new Map<string, LLMProvider>();

  /**
   * 按业务角色调用 LLM
   * @param role 业务角色（legacy/planner/specialist/judge/embedding）
   * @param request 请求（不含 model，由角色映射决定）
   */
  async chatForRole(
    role: ModelRole,
    request: Omit<LLMChatRequest, 'model'>
  ): Promise<LLMChatResponse>;

  /**
   * 用指定 provider 直接调用（连通性测试用）
   */
  async chatDirect(
    providerId: string,
    request: LLMChatRequest
  ): Promise<LLMChatResponse>;

  /**
   * 获取指定 provider 的 embedding 接口
   */
  async embedForRole(
    role: 'embedding',
    texts: string[]
  ): Promise<number[][]>;

  /** 配置变更时清除单个 provider 缓存 */
  invalidateProvider(providerId: string): void;

  /** 清除全部缓存（全局配置变更时） */
  invalidateAll(): void;
}
```

---

## 4. 四个 Provider Adapter 核心差异映射

### 4.1 总览对照表

| 特性 | openai_compatible | openai_responses | anthropic | gemini |
|---|---|---|---|---|
| **SDK/HTTP** | `openai` npm (`chat.completions`) | `openai` npm (`responses.create`) | `@anthropic-ai/sdk` | `@google/generative-ai` 或 REST |
| **系统指令** | `messages[0].role='system'` | `instructions` 参数 | `system` 顶层参数 | `systemInstruction` 参数 |
| **JSON mode** | `response_format: {type:'json_object'}` | `text.format: {type:'json_object'}` | 无原生支持 → prompt 指令 + `JSON.parse` | `responseMimeType: 'application/json'` + `responseSchema` |
| **工具调用请求** | `tools[].type='function'` + `function.{name,description,parameters}` | `tools[].type='function'` + `function.{name,description,parameters}` | `tools[].name` + `input_schema` | `tools[].functionDeclarations[].{name,description,parameters}` |
| **工具结果返回** | `role: 'tool'` + `tool_call_id` | `type: 'function_call_output'` + `call_id` | `role: 'user'` + `content: [{type:'tool_result', tool_use_id}]` | `role: 'function'` + `parts: [{functionResponse}]` |
| **finish_reason** | `stop` / `tool_calls` / `length` | `stop` / `tool_calls` / ... | `end_turn` / `tool_use` / `max_tokens` | `STOP` / `FUNCTION_CALL` / `MAX_TOKENS` |
| **Token 用量** | `usage.{prompt,completion}_tokens` | `usage.{input,output}_tokens` | `usage.{input,output}_tokens` | `usageMetadata.{prompt,candidates}TokenCount` |

### 4.2 各 Adapter 核心转换逻辑

#### 4.2.1 openai_compatible（现有兼容格式）

```typescript
// 请求转换：几乎直通（这就是现有代码逻辑的抽象）
// - LLMMessage → OpenAI ChatCompletionMessage (直接映射)
// - responseFormat='json' → { type: 'json_object' }
// - tools → tools[].function (直接映射)
//
// 响应转换：
// - choices[0].message.content → content
// - choices[0].message.tool_calls → toolCalls
// - choices[0].finish_reason → finishReason (直接映射)
// - usage.{prompt,completion}_tokens → usage
```

#### 4.2.2 openai_responses（Responses API）

```typescript
// 请求转换：
// - system message 提取为 instructions 参数
// - 非 system messages 转为 input items
// - responseFormat='json' → text: { format: { type: 'json_object' } }
// - tools → tools[].function
//
// 响应转换：
// - output items 中 type='message' → content
// - output items 中 type='function_call' → toolCalls
// - status → finishReason 映射
// - usage.{input,output}_tokens → usage
```

#### 4.2.3 anthropic（Messages API）

```typescript
// 请求转换：
// - system message 提取为 system 顶层参数
// - 非 system messages → messages（role 直接映射）
// - responseFormat='json' → 无原生支持，在 system prompt 末尾追加：
//   "You MUST respond with valid JSON only. No other text."
// - tools → tools[].{ name, description, input_schema }
// - tool results → role='user', content: [{ type: 'tool_result', tool_use_id, content }]
//
// 响应转换：
// - content blocks: type='text' → content
// - content blocks: type='tool_use' → toolCalls (id, name, JSON.stringify(input))
// - stop_reason: 'end_turn' → 'stop', 'tool_use' → 'tool_calls', 'max_tokens' → 'length'
// - usage.{input,output}_tokens → usage
//
// JSON mode 容错：
// - JSON.parse(content) 失败时，尝试正则提取 ```json...``` 块
```

#### 4.2.4 gemini（generateContent API）

```typescript
// 请求转换：
// - system message 提取为 systemInstruction: { parts: [{ text }] }
// - messages → contents[].{ role: 'user'|'model', parts: [{ text }] }
//   注意：Gemini 用 'model' 而非 'assistant'
// - responseFormat='json' → generationConfig: {
//     responseMimeType: 'application/json',
//     responseSchema: <如果有的话>
//   }
// - tools → tools: [{ functionDeclarations: [...] }]
// - tool results → role: 'function', parts: [{ functionResponse: { name, response } }]
//
// 响应转换：
// - candidates[0].content.parts: type='text' → content
// - candidates[0].content.parts: functionCall → toolCalls
// - candidates[0].finishReason: 'STOP' → 'stop', 'FUNCTION_CALL' → 'tool_calls', 'MAX_TOKENS' → 'length'
// - usageMetadata.{promptTokenCount, candidatesTokenCount} → usage
```

### 4.3 tool-converter.ts 接口

```typescript
// ── src/llm/tool-converter.ts ───────────────────────────────

import type { LLMToolDefinition } from './types';

/**
 * 将内部通用 LLMToolDefinition 转为各 provider 原生格式。
 * 由各 adapter 在 chat() 中调用。
 */

/** → OpenAI / OpenAI Compatible 格式 */
export function toOpenAITools(tools: LLMToolDefinition[]): object[];

/** → Anthropic 格式 */
export function toAnthropicTools(tools: LLMToolDefinition[]): object[];

/** → Gemini functionDeclarations 格式 */
export function toGeminiTools(tools: LLMToolDefinition[]): object[];
```

---

## 5. 后端 REST API 契约

所有新 API 挂在 `/admin/api/llm/` 下，复用现有 JWT 鉴权中间件。

### 5.1 Provider 管理

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/admin/api/llm/providers` | 列出所有 provider（含 `hasKey` 布尔，不含明文 key） |
| `POST` | `/admin/api/llm/providers` | 创建 provider + 设置 API Key |
| `GET` | `/admin/api/llm/providers/:id` | 获取单个详情 |
| `PUT` | `/admin/api/llm/providers/:id` | 更新（name/base_url/default_model/extra_config/is_enabled） |
| `DELETE` | `/admin/api/llm/providers/:id` | 删除（级联删 secret + role assignments） |

### 5.2 API Key（仅 set/clear，不回显）

| Method | Path | 说明 |
|---|---|---|
| `PUT` | `/admin/api/llm/providers/:id/key` | 设置/更新 API Key |
| `DELETE` | `/admin/api/llm/providers/:id/key` | 清除 API Key |

### 5.3 角色 → 模型映射

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/admin/api/llm/roles` | 列出所有角色及当前绑定 |
| `PUT` | `/admin/api/llm/roles/:role` | 设置角色绑定 |

### 5.4 连通性测试

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/admin/api/llm/providers/:id/test` | 发送简单 prompt 验证 provider 可达 |

### 5.5 通用设置（非 LLM）

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/admin/api/settings` | 列出所有（sensitive 字段 masked） |
| `PUT` | `/admin/api/settings` | 批量更新 |

### 5.6 请求/响应示例

#### 创建 Provider

```jsonc
// POST /admin/api/llm/providers
// Request:
{
  "name": "Anthropic Claude",
  "type": "anthropic",
  "baseUrl": null,
  "defaultModel": "claude-sonnet-4-20250514",
  "apiKey": "sk-ant-xxxx",
  "extraConfig": {}
}

// Response 201:
{
  "id": "a1b2c3d4",
  "name": "Anthropic Claude",
  "type": "anthropic",
  "baseUrl": null,
  "defaultModel": "claude-sonnet-4-20250514",
  "isEnabled": true,
  "hasKey": true,
  "extraConfig": {},
  "createdAt": "2026-03-04T12:00:00Z"
}
```

#### 设置角色绑定

```jsonc
// PUT /admin/api/llm/roles/specialist
// Request:
{
  "providerId": "a1b2c3d4",
  "model": "claude-sonnet-4-20250514"
}

// Response 200:
{
  "role": "specialist",
  "providerId": "a1b2c3d4",
  "providerName": "Anthropic Claude",
  "providerType": "anthropic",
  "model": "claude-sonnet-4-20250514"
}
```

#### 连通性测试

```jsonc
// POST /admin/api/llm/providers/a1b2c3d4/test
// Response 200:
{
  "success": true,
  "latencyMs": 823,
  "model": "claude-sonnet-4-20250514",
  "message": "Hello! I'm Claude, an AI assistant."
}

// Response 200 (失败):
{
  "success": false,
  "latencyMs": 5012,
  "error": "401 Unauthorized: Invalid API key"
}
```

---

## 6. 密钥安全设计

### 6.1 Master Key 管理

```
启动流程:
  1. 读取环境变量 ENCRYPTION_KEY（hex 编码，64 字符）
     ├── 未设置或为空 → 抛出错误，拒绝启动
     ├── 长度不正确   → 抛出错误，提示需要 64 个十六进制字符
     └── 正确         → 解码为 32 字节 Buffer
  2. 主密钥常驻内存（进程生命周期）
  3. 绝对不写入日志、不暴露给 API
```

### 6.2 加密流程（写 API Key）

```
输入: plaintext apiKey (string)
  1. 生成 12 bytes IV: crypto.randomFillSync(new Uint8Array(12))
  2. 创建 cipher: crypto.createCipheriv('aes-256-gcm', masterKey, iv)
  3. 加密: ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  4. 获取 auth tag: authTag = cipher.getAuthTag()  // 16 bytes
  5. 写 DB: INSERT INTO llm_secrets (provider_id, ciphertext, iv, auth_tag, key_version)
```

### 6.3 解密流程（Gateway 需要调 provider）

```
输入: provider_id
  1. 从 DB 读取: { ciphertext, iv, auth_tag, key_version }
  2. 创建 decipher: crypto.createDecipheriv('aes-256-gcm', masterKey, iv)
  3. 设置 auth tag: decipher.setAuthTag(authTag)
  4. 解密: plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  5. 返回明文 API Key → 传给 provider factory
  6. 解密后的 key 随 provider 实例缓存在 Gateway.cache 中
```

### 6.4 密钥轮换

```
场景: 管理员更换 ENCRYPTION_KEY
  1. 启动时读取新的 ENCRYPTION_KEY 环境变量
  2. 查询所有 llm_secrets WHERE key_version < current_version
  3. 逐条: 用旧 key 解密 → 用新 key 重加密 → 更新 key_version
  4. 如果旧 key 不可用（环境变量缺失）→ 启动报错，要求重新设置所有 API Key
```

---

## 7. 前端配置页设计

### 7.1 页面结构

```
Settings 页面
├── 🔌 LLM Providers（Tab 或独立 Card）
│   │
│   ├── Provider 列表表格
│   │   ┌──────────────────────────────────────────────────────────────┐
│   │   │ 名称              │ 类型          │ 默认模型      │ Key │ 状态   │ 操作 │
│   │   ├───────────────────┼───────────────┼───────────────┼─────┼────────┼──────┤
│   │   │ 公司 OpenAI 代理  │ OpenAI Compat │ gpt-4o-mini   │ ●   │ [开关] │ [⋮] │
│   │   │ Anthropic Claude  │ Anthropic     │ claude-sonnet  │ ●   │ [开关] │ [⋮] │
│   │   │ Google Gemini     │ Gemini        │ gemini-2.5-pro│ ○   │ [开关] │ [⋮] │
│   │   └──────────────────────────────────────────────────────────────┘
│   │   + 添加 Provider 按钮
│   │
│   ├── 添加/编辑 Provider 对话框
│   │   ├── 名称 (text input)
│   │   ├── 类型 (select dropdown)
│   │   │   ├── OpenAI Compatible   — 兼容 OpenAI 接口的第三方服务
│   │   │   ├── OpenAI Responses    — OpenAI 官方 Responses API
│   │   │   ├── Anthropic           — Anthropic Messages API
│   │   │   └── Gemini              — Google Gemini API
│   │   ├── Base URL (text, 条件显示：openai_compatible 必填, 其他可选)
│   │   ├── 默认模型 (text + autocomplete suggestions)
│   │   ├── API Key (password input, 已有时显示 ••••••••)
│   │   ├── ▸ 高级配置 (collapsible, JSON key-value editor)
│   │   └── [测试连接] [保存] [取消]
│   │
│   └── 🧩 角色分配 区域
│       ┌──────────────────────────────────────────────────────────────┐
│       │ 角色         │ Provider 下拉        │ 模型 ID              │
│       ├──────────────┼──────────────────────┼──────────────────────┤
│       │ Legacy 审查  │ [公司 OpenAI 代理 ▾] │ [gpt-4o-mini      ] │
│       │ Planner      │ [公司 OpenAI 代理 ▾] │ [gpt-4o-mini      ] │
│       │ Specialist   │ [Anthropic Claude ▾] │ [claude-sonnet-4   ] │
│       │ Judge        │ [公司 OpenAI 代理 ▾] │ [gpt-4o           ] │
│       │ Embedding    │ [公司 OpenAI 代理 ▾] │ [text-embedding-3  ] │
│       └──────────────────────────────────────────────────────────────┘
│       [保存角色分配]
│
├── ⚙️ 通用设置（现有 Gitea / 飞书 / App / Review 参数）
│   └── (复用现有 ConfigManager 组件，数据源统一为 DB)
```

### 7.2 交互规则

| 交互 | 行为 |
|---|---|
| **添加 Provider** | 弹出对话框；类型选择后动态显示/隐藏 `base_url` 字段 |
| **API Key 输入** | 已有 key 时展示 `••••••••`（readonly 占位）；清空内容后保存 = 删除 key；输入新值 = 替换（调用 `PUT /key`）；未修改 = 不发请求 |
| **测试连接** | 点击后调 `POST /providers/:id/test`；显示 spinner → 成功绿色 toast（延迟+模型）/ 失败红色 toast（错误信息） |
| **角色分配下拉** | 仅显示 `is_enabled=true` 且 `hasKey=true` 的 provider；选择后自动填充该 provider 的 `default_model`（用户可修改） |
| **禁用 Provider** | 如果有角色绑定到此 provider → 弹确认对话框："此 Provider 正被以下角色使用：[...]，禁用后这些角色将无法调用 LLM。确定禁用？" |
| **删除 Provider** | 同上，级联影响提示更强烈 |
| **模型建议** | 根据 provider type 显示常见模型建议列表（硬编码在前端，仅作参考，不限制输入） |

### 7.3 模型建议列表（前端硬编码参考）

```typescript
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  openai_compatible: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'deepseek-chat', 'qwen-plus'],
  openai_responses: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-opus-4-20250514'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};
```

---

## 8. 现有调用点改造清单

### 8.1 后端代码改造

| # | 文件 | 当前代码 | 改造为 | 影响范围 |
|---|---|---|---|---|
| 1 | `src/index.ts:69-71` | `const openaiClient = new OpenAI({baseURL, apiKey})` | 删除；初始化 `LLMGateway` 单例并传入业务层 | 入口 |
| 2 | `src/services/ai-review.ts:8-10` | `const openai = new OpenAI({...})` | 删除模块级 client；函数接收 `LLMGateway` 参数；`openai.chat.completions.create()` → `gateway.chatForRole('legacy', ...)` | Legacy 审查 |
| 3 | `src/review/orchestrator.ts:45,61-63` | `private readonly openai: OpenAI` + `this.openai = new OpenAI(...)` | 构造函数改接收 `LLMGateway`；传给各 agent | Agent 编排 |
| 4 | `src/review/agents/specialist-agent.ts:93` | `protected readonly openai: OpenAI` | → `protected readonly gateway: LLMGateway`；`reviewLegacy()` 和 `reviewWithReAct()` 中的 `this.openai.chat.completions.create()` 改为 `this.gateway.chatForRole('specialist', ...)` | 核心 agent |
| 5 | `src/review/agents/critic-agent.ts:23` | `private openai: OpenAI` | 同上 | 评审 agent |
| 6 | `src/review/agents/reflexion-agent.ts:24` | `constructor(openai: OpenAI, ...)` | 构造传 gateway | 反思 agent |
| 7 | `src/review/agents/debate-orchestrator.ts:17` | `private openai: OpenAI` | 同上 | 辩论 agent |
| 8 | `src/review/tools/registry.ts:22` | `toOpenAIFunctions()` | → `toToolDefinitions(): LLMToolDefinition[]`（返回内部格式），由 adapter 的 `tool-converter.ts` 负责转换 | 工具注册 |
| 9 | `src/config/config-schema.ts:120-138` | `OPENAI_BASE_URL/API_KEY/MODEL` 字段定义 | 删除这些字段；`group: 'openai'` → 整个 group 移除 | 配置 schema |
| 10 | `src/config/config-manager.ts:44-46` | `OPENAI_*` Zod schema 条目 | 删除 | 配置验证 |
| 11 | `src/config/config-manager.ts:271-273` | `openai: { baseUrl, apiKey, model }` 映射 | 删除整个 `openai` 块 | 配置输出 |

### 8.2 前端代码改造

| # | 文件 | 改造内容 |
|---|---|---|
| 1 | `frontend/src/services/configService.ts` | 新增 `llmProviderService.ts`（Provider CRUD + Key 管理 + Role 管理 + Test） |
| 2 | `frontend/src/components/ConfigManager.tsx` | 添加 "LLM Providers" Tab/Card，引入新组件 |
| 3 | 新增 | `frontend/src/components/llm/ProviderList.tsx` — Provider 列表表格 |
| 4 | 新增 | `frontend/src/components/llm/ProviderDialog.tsx` — 添加/编辑对话框 |
| 5 | 新增 | `frontend/src/components/llm/RoleAssignment.tsx` — 角色分配面板 |

### 8.3 配置层改造

| 变更 | 说明 |
|---|---|
| `config-manager.ts` | 精简为只管非 LLM 配置；数据源统一为 `system_settings` 表 |
| `config-schema.ts` | 移除 `openai` group 及其字段；保留 gitea/feishu/app/admin/review（非模型）字段 |
| `controllers/config.ts` | LLM 相关接口迁到 `controllers/llm-config.ts`；通用配置接口改读写 DB |
| `.env.example` | 移除 `OPENAI_*` 和 `REVIEW_MODEL_*`；仅保留启动参数 |

---

## 9. 实施阶段建议

| 阶段 | 内容 | 依赖 | 估时 |
|---|---|---|---|
| **Phase 1: 基础设施** | DB 层 (`bun:sqlite` 初始化 + DDL) + crypto 模块 | 无 | 1d |
| **Phase 2: LLM 抽象层** | `src/llm/` 全部（types + capabilities + errors + gateway + 4 adapters + tool-converter） | Phase 1 | 2d |
| **Phase 3: 后端 API + 调用点替换** | `controllers/llm-config.ts` + 替换 11 个现有 OpenAI 调用点 + 测试 | Phase 2 | 1.5d |
| **Phase 4: 前端改造** | Provider 管理 + 角色分配 + 连接测试 UI + 通用设置切 DB | Phase 3 | 1.5d |
| **Phase 5: 清理与验收** | 删除旧代码 + 更新文档 + E2E 测试 + `.env.example` 精简 | Phase 4 | 0.5d |

**总计约 6.5 人天。**

### 关键里程碑

```
Day 1:    DB + crypto 就绪，配置写入链路打通
Day 3:    LLM Gateway 可用，4 个 adapter 通过单元测试
Day 4.5:  后端 API 完成，所有调用点已替换，`bun test` 全绿
Day 6:    前端配置页可用，可通过 UI 添加/测试 Provider
Day 6.5:  旧代码清理完毕，文档更新，Ready for review
```

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **Anthropic 无原生 JSON mode** | `response_format: json_object` 不可用，JSON 解析可能失败 | Adapter 内 prompt 注入 JSON 指令 + `JSON.parse()` 容错（正则提取 \`\`\`json\`\`\` 块 → 重试 parse） |
| **Gemini function calling 格式差异大** | `functionDeclarations` 包装层级不同；`functionResponse` 嵌套在 `parts` 中 | `tool-converter.ts` 单独处理；finish reason 映射表全覆盖测试 |
| **Embedding 维度变化导致 Qdrant 不兼容** | `src/review/memory/vector-store.ts` 硬编码 1536 维 | `model_role_assignments.role='embedding'` 变更时，UI 提示用户需重建 collection；或自动检测维度创建新 collection |
| **ENCRYPTION_KEY 丢失** | 所有加密的 API Key 不可恢复 | 启动时检测密钥版本不匹配 → 报错并要求重新设置所有 API Key（trade-off：安全性 > 便利性） |
| **SQLite 并发写** | 多请求同时写入可能 SQLITE_BUSY | `bun:sqlite` 开启 WAL mode；写操作走单连接序列化；读可并行 |
| **Provider SDK 版本冲突** | `openai`、`@anthropic-ai/sdk`、`@google/generative-ai` 三个 SDK 共存 | 各 adapter 独立 import，无交叉依赖；`package.json` 锁定主版本 |
| **配置热更新** | UI 修改 provider 配置后，正在进行的审查仍用旧配置 | Gateway 缓存按 provider_id 粒度 invalidate；正在执行的请求不受影响（用的是已创建的实例），下次请求用新实例 |

---

## 附录 A: 新增依赖

```jsonc
// package.json 新增
{
  "dependencies": {
    // bun:sqlite 是 Bun 内置，无需安装
    "@anthropic-ai/sdk": "^0.39.0",         // Anthropic adapter
    "@google/generative-ai": "^0.24.0"      // Gemini adapter
    // "openai" 已存在: "^4.87.3"           // OpenAI compatible + Responses adapter
  }
}
```

## 附录 B: 环境变量精简

```bash
# .env.example（仅保留启动参数）

# 应用启动参数（不可通过 UI 设置）
PORT=3000
WEBHOOK_SECRET=your_webhook_secret
DATABASE_PATH=./data/assistant.db    # SQLite 文件路径

# 以下配置已迁入数据库，通过 Web UI 管理：
# - LLM Provider 配置（API Key / Base URL / Model）
# - Gitea 配置（API URL / Token）
# - 飞书配置（Webhook URL / Secret）
# - Review 引擎配置
# - 记忆系统配置
```
