import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createProvider, updateProvider, setApiKey } from '@/services/llmProviderService';
import type { ProviderDto, ProviderType } from '@/services/llmProviderService';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ModelCombobox } from './ModelCombobox';

interface ProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: ProviderDto;
}

const TYPE_OPTIONS: { value: ProviderType; label: string; description: string }[] = [
  { value: 'openai_compatible', label: 'OpenAI 兼容', description: '兼容 OpenAI 接口的第三方服务' },
  { value: 'openai_responses', label: 'OpenAI Responses', description: 'OpenAI 官方 Responses API' },
  { value: 'anthropic', label: 'Anthropic', description: 'Anthropic Messages API' },
  { value: 'gemini', label: 'Gemini', description: 'Google Gemini API' },
];

export function ProviderDialog({ open, onOpenChange, provider }: ProviderDialogProps) {
  if (!open) return null;

  // Inner component mounts fresh each time dialog opens,
  // so useState initializers read directly from provider props.
  return <ProviderDialogInner onOpenChange={onOpenChange} provider={provider} />;
}

function ProviderDialogInner({ onOpenChange, provider }: Omit<ProviderDialogProps, 'open'>) {
  const queryClient = useQueryClient();
  const isEdit = !!provider;

  const [name, setName] = useState(provider?.name ?? '');
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'openai_compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? '');
  const [apiKey, setApiKeyInput] = useState('');

  const saveMutation = useMutation({
    mutationFn: async () => {
      let savedProvider: ProviderDto;
      
      const payload: Partial<ProviderDto> & { apiKey?: string } = {
        name,
        type,
        baseUrl: baseUrl || null,
        defaultModel,
      };

      if (!isEdit) {
        if (apiKey) payload.apiKey = apiKey;
        savedProvider = await createProvider(payload);
      } else {
        savedProvider = await updateProvider(provider.id, {
          name,
          type,
          baseUrl: baseUrl || null,
          defaultModel,
        });
        if (apiKey) {
          await setApiKey(provider.id, apiKey);
        }
      }
      return savedProvider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      toast.success(isEdit ? '提供商已更新' : '提供商已创建');
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      toast.error(`保存失败: ${err?.response?.data?.error || err.message}`);
    }
  });

  const isBaseUrlRequired = type === 'openai_compatible';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return toast.error('请输入名称');
    if (!defaultModel) return toast.error('请输入默认模型');
    if (isBaseUrlRequired && !baseUrl) return toast.error('该类型必须填写 Base URL');
    if (!isEdit && !apiKey) return toast.error('创建提供商时必须提供 API Key');
    
    saveMutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-surface-overlay backdrop-blur-sm">
      <div className="theme-dialog-panel">
        <div className="theme-dialog-header">
          <h2 className="text-xl font-bold text-foreground">{isEdit ? '编辑提供商' : '添加提供商'}</h2>
        </div>
        
        <form onSubmit={handleSubmit} className="theme-dialog-body space-y-5">
          <div className="space-y-2">
            <Label htmlFor="name">名称 <span className="text-danger">*</span></Label>
            <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="如: DeepSeek" autoComplete="off" className="bg-muted/50 border-border text-foreground" />
          </div>

          <div className="space-y-2">
            <Label>类型 <span className="text-danger">*</span></Label>
            <Select value={type} onValueChange={(v) => setType(v as ProviderType)}>
              <SelectTrigger className="bg-muted/50 border-border text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border text-foreground">
                {TYPE_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value} description={opt.description}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="baseUrl">Base URL {isBaseUrlRequired ? <span className="text-danger">*</span> : <span className="text-muted-foreground">(可选)</span>}</Label>
            <Input 
              id="baseUrl" 
              value={baseUrl} 
              onChange={e => setBaseUrl(e.target.value)} 
              placeholder={isBaseUrlRequired ? "https://api.openai.com/v1" : "留空以使用默认地址"} 
              autoComplete="off"
              className="bg-muted/50 border-border text-foreground" 
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultModel">默认模型 <span className="text-danger">*</span></Label>
            <ModelCombobox
              providerType={type}
              value={defaultModel}
              onChange={setDefaultModel}
              placeholder="如: gpt-4o"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key {!isEdit && <span className="text-danger">*</span>}</Label>
            <Input 
              id="apiKey" 
              type="password"
              value={apiKey} 
              onChange={e => setApiKeyInput(e.target.value)} 
              placeholder={isEdit && provider?.hasKey ? '•••••••• (输入以覆盖)' : 'sk-...'} 
              autoComplete="off"
              className="bg-muted/50 border-border text-foreground" 
            />
          </div>

        </form>

        <div className="theme-dialog-footer flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="border-border text-muted-foreground hover:text-foreground hover:bg-accent">
            取消
          </Button>
          <Button type="submit" onClick={handleSubmit} disabled={saveMutation.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
            {saveMutation.isPending ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}
