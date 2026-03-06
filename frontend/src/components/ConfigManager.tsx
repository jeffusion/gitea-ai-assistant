import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, updateConfig, resetConfig } from '@/services/configService';
import type { ConfigResponse } from '@/services/configService';
import { ConfigGroupCard } from './ConfigGroupCard';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Save, AlertCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

/** Groups shown on the system config page (excludes review & memory — moved to ReviewConfigPage). */
const SYSTEM_GROUPS = new Set(['gitea', 'feishu', 'security']);

export function ConfigManager() {
  const queryClient = useQueryClient();
  const [localConfig, setLocalConfig] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const { data, isLoading, isError, error } = useQuery<ConfigResponse, Error>({
    queryKey: ['config'],
    queryFn: fetchConfig,
  });

  // Initialize local config from fetched data
  useEffect(() => {
    if (data) {
      const initialState: Record<string, any> = {};
      data.groups.filter((g) => SYSTEM_GROUPS.has(g.key)).forEach((group) => {
        group.fields.forEach((field) => {
          if (field.sensitive && field.hasValue) {
            initialState[field.envKey] = '••••••••';
          } else {
            // For boolean, keep as boolean. For others, string/number.
            // If value is undefined or null, use empty string.
            if (field.type === 'boolean') {
              initialState[field.envKey] = field.value === 'true' || field.value === true;
            } else {
              initialState[field.envKey] = field.value ?? '';
            }
          }
        });
      });
      setLocalConfig(initialState);
      setHasChanges(false);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (configData: Record<string, string>) => updateConfig(configData),
    onSuccess: () => {
      toast.success('配置已成功保存');
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setHasChanges(false);
    },
    onError: (err: Error) => {
      toast.error(`保存失败: ${err.message}`);
    },
  });

  const resetMutation = useMutation({
    mutationFn: (keys: string[]) => resetConfig(keys),
    onSuccess: () => {
      toast.success('配置已重置');
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (err: Error) => {
      toast.error(`重置失败: ${err.message}`);
    },
  });

  const handleFieldChange = (envKey: string, value: any) => {
    setLocalConfig((prev) => ({
      ...prev,
      [envKey]: value,
    }));
    setHasChanges(true);
  };

  const handleSave = () => {
    const payload: Record<string, string> = {};

    for (const [key, val] of Object.entries(localConfig)) {
      if (typeof val === 'boolean') {
        payload[key] = val ? 'true' : 'false';
      } else {
        payload[key] = val === undefined || val === null ? '' : String(val);
      }
    }

    saveMutation.mutate(payload);
  };

  const handleResetGroup = (keys: string[]) => {
    if (confirm('确定要重置这些配置到默认值吗？这将立即生效并重载关联设置。')) {
      resetMutation.mutate(keys);
    }
  };

  const handleResetAll = () => {
    if (!data) return;
    const allOverrideKeys = data.groups
      .filter((g) => SYSTEM_GROUPS.has(g.key))
      .flatMap((g) => g.fields)
      .filter((f) => f.source === 'db')
      .map((f) => f.envKey);
    if (allOverrideKeys.length === 0) return;
    if (confirm('确定要重置所有配置到默认值吗？这将立即生效。')) {
      resetMutation.mutate(allOverrideKeys);
    }
  };

  const visibleGroups = data?.groups.filter((g) => SYSTEM_GROUPS.has(g.key));

  const hasOverrides = visibleGroups?.some((g) =>
    g.fields.some((f) => f.source === 'db')
  ) ?? false;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center mb-6">
          <Skeleton className="h-10 w-48 bg-zinc-900/50" />
          <Skeleton className="h-10 w-24 bg-zinc-900/50" />
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl bg-zinc-900/50 border border-white/5" />
        <Skeleton className="h-[300px] w-full rounded-xl bg-zinc-900/50 border border-white/5" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-500 rounded-lg flex items-center gap-3 glass-panel">
        <AlertCircle className="w-5 h-5 text-rose-500" />
        <div className="font-medium tracking-wide">加载配置失败: {error.message}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-12">
      {/* 固定在顶部的操作栏 */}
      <div className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-xl border-b border-white/10 py-3 px-4 md:px-6 lg:px-8 shadow-2xl">
        <div className="flex items-center justify-end gap-3 max-w-5xl mx-auto">
          <Button
            variant="outline"
            onClick={handleResetAll}
            disabled={!hasOverrides || resetMutation.isPending}
            className="border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            全部重置
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
            className="min-w-[130px] bg-primary text-zinc-950 font-bold hover:bg-primary/90 tech-glow transition-all"
          >
            {saveMutation.isPending ? (
              <span className="flex items-center gap-2">
                <span className="size-4 animate-spin rounded-full border-2 border-zinc-950 border-t-transparent" /> 保存中...
              </span>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                保存配置
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto space-y-8 mt-6 px-4 md:px-6 lg:px-8">
        {visibleGroups?.map((group) => (
          <ConfigGroupCard
            key={group.key}
            group={group}
            localConfig={localConfig}
            onFieldChange={handleFieldChange}
            onReset={handleResetGroup}
            isResetting={resetMutation.isPending}
          />
        ))}
      </div>
    </div>
  );
}
