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
const SYSTEM_GROUPS = new Set(['gitea', 'security']);

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
          <Skeleton className="h-10 w-48 bg-muted/60" />
          <Skeleton className="h-10 w-24 bg-muted/60" />
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl bg-muted/60 border border-border/60" />
        <Skeleton className="h-[300px] w-full rounded-xl bg-muted/60 border border-border/60" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="theme-error-panel flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-danger" />
        <div className="font-medium tracking-wide">加载配置失败: {error.message}</div>
      </div>
    );
  }

  return (
    <div className="theme-page-frame">
      {/* 固定在顶部的操作栏 */}
      <div className="sticky top-0 z-10 theme-sticky-bar py-3 px-4 md:px-6 lg:px-8">
        <div className="theme-page-actions">
          <Button
            variant="outline"
            onClick={handleResetAll}
            disabled={!hasOverrides || resetMutation.isPending}
            className="theme-interactive-elevate border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            全部重置
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
            className="theme-interactive-elevate min-w-[130px] bg-primary text-primary-foreground font-bold hover:bg-primary/90 tech-glow transition-all"
          >
            {saveMutation.isPending ? (
              <span className="flex items-center gap-2">
                <span className="size-4 animate-spin rounded-full border-2 border-primary-foreground/50 border-t-transparent" /> 保存中...
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

      <div className="theme-page-content">
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
