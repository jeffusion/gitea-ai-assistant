import api from '@/lib/api';

export type ProviderType = 'openai_compatible' | 'openai_responses' | 'anthropic' | 'gemini';

export interface ProviderDto {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  defaultModel: string;
  isEnabled: boolean;
  hasKey: boolean;
  extraConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface TestResult {
  success: boolean;
  latencyMs?: number;
  model?: string;
  message?: string;
  error?: string;
}

/** Fallback suggestions when API is unavailable (e.g. catalog not loaded yet). */
const FALLBACK_SUGGESTIONS: Record<ProviderType, string[]> = {
  openai_compatible: ['gpt-4o', 'gpt-4o-mini', 'deepseek-chat'],
  openai_responses: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};

export const fetchModelSuggestions = async (): Promise<Record<string, string[]>> => {
  try {
    const response = await api.get<Record<string, string[]>>('/llm/model-suggestions');
    return response.data;
  } catch {
    return FALLBACK_SUGGESTIONS;
  }
};

export const fetchProviders = async (): Promise<ProviderDto[]> => {
  const response = await api.get<ProviderDto[]>('/llm/providers');
  return response.data;
};

export const createProvider = async (data: Partial<ProviderDto> & { apiKey?: string }): Promise<ProviderDto> => {
  const response = await api.post<ProviderDto>('/llm/providers', data);
  return response.data;
};

export const updateProvider = async (id: string, data: Partial<ProviderDto>): Promise<ProviderDto> => {
  const response = await api.put<ProviderDto>(`/llm/providers/${id}`, data);
  return response.data;
};

export const deleteProvider = async (id: string): Promise<void> => {
  await api.delete(`/llm/providers/${id}`);
};

export const setApiKey = async (id: string, apiKey: string): Promise<void> => {
  await api.put(`/llm/providers/${id}/key`, { apiKey });
};

export const deleteApiKey = async (id: string): Promise<void> => {
  await api.delete(`/llm/providers/${id}/key`);
};

export const testProvider = async (id: string): Promise<TestResult> => {
  const response = await api.post<TestResult>(`/llm/providers/${id}/test`);
  return response.data;
};
