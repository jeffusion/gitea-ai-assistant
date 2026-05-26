/**
 * REST API controller for LLM provider configuration.
 * Mounted under /admin/api/llm/ with JWT authentication.
 */

import { Hono } from 'hono';
import {
  type CreateProviderInput,
  type UpdateProviderInput,
  providerRepo,
} from '../db/repositories/provider-repo';
import { secretRepo } from '../db/repositories/secret-repo';
import { settingsRepo } from '../db/repositories/settings-repo';
import { llmGateway } from '../llm/gateway';
import { tokenCounter } from '../review/context/token-counter';

export const llmConfigRouter = new Hono();

// ── Provider CRUD ───────────────────────────────────────────────────────

llmConfigRouter.get('/providers', (c) => {
  const providers = providerRepo.list();
  const result = providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.base_url,
    defaultModel: p.default_model,
    isEnabled: p.is_enabled === 1,
    hasKey: secretRepo.has(p.id),
    extraConfig: safeParseJson(p.extra_config),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));
  return c.json(result);
});

llmConfigRouter.get('/providers/:id', (c) => {
  const provider = providerRepo.getById(c.req.param('id'));
  if (!provider) return c.json({ message: 'Provider not found' }, 404);

  return c.json({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.base_url,
    defaultModel: provider.default_model,
    isEnabled: provider.is_enabled === 1,
    hasKey: secretRepo.has(provider.id),
    extraConfig: safeParseJson(provider.extra_config),
    createdAt: provider.created_at,
    updatedAt: provider.updated_at,
  });
});

llmConfigRouter.post('/providers', async (c) => {
  const body = await c.req.json<{
    name: string;
    type: string;
    baseUrl?: string | null;
    defaultModel: string;
    apiKey?: string;
    extraConfig?: Record<string, unknown>;
  }>();

  if (!body.name || !body.type || !body.defaultModel) {
    return c.json({ message: 'Missing required fields: name, type, defaultModel' }, 400);
  }

  const validTypes = ['openai_compatible', 'openai_responses', 'anthropic', 'gemini'];
  if (!validTypes.includes(body.type)) {
    return c.json({ message: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);
  }

  if (body.type === 'openai_compatible' && !body.baseUrl) {
    return c.json({ message: 'baseUrl is required for openai_compatible type' }, 400);
  }

  const input: CreateProviderInput = {
    name: body.name,
    type: body.type as any,
    baseUrl: body.baseUrl,
    defaultModel: body.defaultModel,
    extraConfig: body.extraConfig,
  };

  const created = providerRepo.create(input);

  if (body.apiKey) {
    secretRepo.set(created.id, body.apiKey);
  }

  return c.json(
    {
      id: created.id,
      name: created.name,
      type: created.type,
      baseUrl: created.base_url,
      defaultModel: created.default_model,
      isEnabled: created.is_enabled === 1,
      hasKey: !!body.apiKey,
      extraConfig: safeParseJson(created.extra_config),
      createdAt: created.created_at,
    },
    201
  );
});

llmConfigRouter.put('/providers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    baseUrl?: string | null;
    defaultModel?: string;
    isEnabled?: boolean;
    extraConfig?: Record<string, unknown>;
  }>();

  const input: UpdateProviderInput = {};
  if (body.name !== undefined) input.name = body.name;
  if (body.baseUrl !== undefined) input.baseUrl = body.baseUrl;
  if (body.defaultModel !== undefined) input.defaultModel = body.defaultModel;
  if (body.isEnabled !== undefined) input.isEnabled = body.isEnabled;
  if (body.extraConfig !== undefined) input.extraConfig = body.extraConfig;

  const updated = providerRepo.update(id, input);
  if (!updated) return c.json({ message: 'Provider not found' }, 404);

  llmGateway.invalidateProvider(id);

  return c.json({
    id: updated.id,
    name: updated.name,
    type: updated.type,
    baseUrl: updated.base_url,
    defaultModel: updated.default_model,
    isEnabled: updated.is_enabled === 1,
    hasKey: secretRepo.has(updated.id),
    extraConfig: safeParseJson(updated.extra_config),
    updatedAt: updated.updated_at,
  });
});

llmConfigRouter.delete('/providers/:id', (c) => {
  const id = c.req.param('id');
  const deleted = providerRepo.delete(id);
  if (!deleted) return c.json({ message: 'Provider not found' }, 404);

  llmGateway.invalidateProvider(id);
  return c.json({ success: true });
});

// ── API Key Management ──────────────────────────────────────────────────

llmConfigRouter.put('/providers/:id/key', async (c) => {
  const id = c.req.param('id');
  const provider = providerRepo.getById(id);
  if (!provider) return c.json({ message: 'Provider not found' }, 404);

  const { apiKey } = await c.req.json<{ apiKey: string }>();
  if (!apiKey) return c.json({ message: 'apiKey is required' }, 400);

  secretRepo.set(id, apiKey);
  llmGateway.invalidateProvider(id);
  return c.json({ success: true });
});

llmConfigRouter.delete('/providers/:id/key', (c) => {
  const id = c.req.param('id');
  const provider = providerRepo.getById(id);
  if (!provider) return c.json({ message: 'Provider not found' }, 404);

  secretRepo.delete(id);
  llmGateway.invalidateProvider(id);
  return c.json({ success: true });
});

// ── Connection Test ─────────────────────────────────────────────────────

llmConfigRouter.post('/providers/:id/test', async (c) => {
  const id = c.req.param('id');
  const provider = providerRepo.getById(id);
  if (!provider) return c.json({ message: 'Provider not found' }, 404);

  if (!secretRepo.has(id)) {
    return c.json({ success: false, error: 'No API key configured' });
  }

  const startTime = Date.now();
  try {
    llmGateway.invalidateProvider(id);
    const response = await llmGateway.chatDirect(id, {
      model: provider.default_model,
      messages: [{ role: 'user', content: 'Hello! Please respond with a short greeting.' }],
      maxTokens: 50,
    });

    return c.json({
      success: true,
      latencyMs: Date.now() - startTime,
      model: provider.default_model,
      message: response.content?.slice(0, 200) || '(empty response)',
    });
  } catch (error: any) {
    return c.json({
      success: false,
      latencyMs: Date.now() - startTime,
      error: error.message || 'Unknown error',
    });
  }
});

// ── Model Suggestions (from models.dev via tokenlens) ───────────────────

/**
 * Map our ProviderType to models.dev provider keys.
 * openai_compatible is special: it aggregates multiple providers since
 * users often point compatible endpoints at DeepSeek, Qwen, etc.
 */
const PROVIDER_TYPE_TO_CATALOG_KEYS: Record<string, string[]> = {
  openai_compatible: ['openai', 'deepseek', 'qwen'],
  openai_responses: ['openai'],
  anthropic: ['anthropic'],
  gemini: ['google'],
};

llmConfigRouter.get('/model-suggestions', async (c) => {
  // Ensure catalog is loaded (lazy init on first request)
  if (!tokenCounter.hasCatalog) {
    await tokenCounter.refreshCatalog();
  }

  const result: Record<string, string[]> = {};

  for (const [providerType, catalogKeys] of Object.entries(PROVIDER_TYPE_TO_CATALOG_KEYS)) {
    const models: string[] = [];
    for (const key of catalogKeys) {
      models.push(...tokenCounter.getModelSuggestions(key));
    }
    result[providerType] = models;
  }

  return c.json(result);
});

// ── System Settings ─────────────────────────────────────────────────────

llmConfigRouter.get('/settings', (c) => {
  return c.json(settingsRepo.listAll());
});

llmConfigRouter.put('/settings', async (c) => {
  const entries = await c.req.json<Array<{ key: string; value: string; sensitive?: boolean }>>();
  if (!Array.isArray(entries)) {
    return c.json({ message: 'Body must be an array of {key, value, sensitive?}' }, 400);
  }
  settingsRepo.setMany(entries);
  return c.json({ success: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function safeParseJson(str: string | null | undefined): Record<string, unknown> {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
