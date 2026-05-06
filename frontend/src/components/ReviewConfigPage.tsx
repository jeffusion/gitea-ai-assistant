import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, updateConfig, resetConfig } from '@/services/configService';
import type { ConfigResponse, ConfigGroupDto, ConfigFieldDto } from '@/services/configService';
import { ConfigGroupCard } from './ConfigGroupCard';
import { ModelCombobox } from './llm/ModelCombobox';
import { ProviderList } from './llm/ProviderList';
import { RoleAssignment } from './llm/RoleAssignment';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Save, AlertCircle, RotateCcw, Layers } from 'lucide-react';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Engine-specific field visibility
// ---------------------------------------------------------------------------

type EngineMode = 'kernel' | 'codex';

/** The engine selector field — always visible at the top. */
const ENGINE_FIELD = 'REVIEW_ENGINE';

const AGENT_SHARED_FIELDS = new Set([
  'GLOBAL_PROMPT',
  'REVIEW_WORKDIR',
  'REVIEW_MAX_PARALLEL_RUNS',
  'REVIEW_MAX_FILES_PER_RUN',
  'REVIEW_MAX_FILE_CONTENT_CHARS',
]);

const KERNEL_ONLY_FIELDS = new Set([
  'REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE',
  'REVIEW_ENABLE_HUMAN_GATE',
  'REVIEW_ALLOWED_COMMANDS',
  'REVIEW_COMMAND_TIMEOUT_MS',
  'LLM_MAX_CONCURRENT_CALLS',
  'LLM_RETRY_MAX_ATTEMPTS',
  'LLM_RETRY_BASE_DELAY_MS',
  'ENABLE_TRIAGE',
]);

/** Fields specific to codex mode only. */
const CODEX_FIELDS = new Set([
  'CODEX_API_URL',
  'CODEX_API_KEY',
  'CODEX_MODEL',
  'CODEX_TIMEOUT_MS',
  'CODEX_REVIEW_PROMPT',
  'REVIEW_WORKDIR',
  'REVIEW_MAX_PARALLEL_RUNS',
  'REVIEW_MAX_FILES_PER_RUN',
  'REVIEW_MAX_FILE_CONTENT_CHARS',
]);

/** Field rendered with ModelCombobox instead of plain input. */
const CODEX_MODEL_FIELD = 'CODEX_MODEL';

function getVisibleFields(engine: EngineMode, fields: ConfigFieldDto[]): ConfigFieldDto[] {
  return fields.filter((f) => {
    if (f.envKey === ENGINE_FIELD) return false; // rendered separately
    switch (engine) {
      case 'kernel':
        return AGENT_SHARED_FIELDS.has(f.envKey) || KERNEL_ONLY_FIELDS.has(f.envKey);
      case 'codex':
        return CODEX_FIELDS.has(f.envKey);
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Engine selector badges
// ---------------------------------------------------------------------------

const ENGINE_OPTIONS: { value: EngineMode; label: string; description: string }[] = [
  { value: 'kernel', label: 'Kernel', description: 'PR Session + Agentic Loop 审查' },
  { value: 'codex', label: 'Codex', description: 'Codex CLI 审查' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReviewConfigPage() {
  const queryClient = useQueryClient();
  const [localConfig, setLocalConfig] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const { data, isLoading, isError, error } = useQuery<ConfigResponse, Error>({
    queryKey: ['config'],
    queryFn: fetchConfig,
  });

  // Derived: current engine mode
  const engine: EngineMode = useMemo(() => {
    const val = localConfig[ENGINE_FIELD];
    if (val === 'kernel' || val === 'codex') return val;
    return 'kernel';
  }, [localConfig]);

  // Derived: review group and memory group from fetched data
  const reviewGroup = useMemo(() => data?.groups.find((g) => g.key === 'review'), [data]);
  const memoryGroup = useMemo(() => data?.groups.find((g) => g.key === 'memory'), [data]);

  // Initialize local config from ALL groups (so save works for review + memory fields)
  useEffect(() => {
    if (data) {
      const initialState: Record<string, any> = {};
      data.groups
        .filter((g) => g.key === 'review' || g.key === 'memory')
        .forEach((group) => {
          group.fields.forEach((field) => {
            if (field.sensitive && field.hasValue) {
              initialState[field.envKey] = '••••••••';
            } else if (field.type === 'boolean') {
              initialState[field.envKey] = field.value === 'true' || field.value === true;
            } else {
              initialState[field.envKey] = field.value ?? '';
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
      toast.success('审查配置已保存');
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
    setLocalConfig((prev) => ({ ...prev, [envKey]: value }));
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
    const groups = [reviewGroup, memoryGroup].filter(Boolean) as ConfigGroupDto[];
    const allOverrideKeys = groups
      .flatMap((g) => g.fields)
      .filter((f) => f.source === 'db')
      .map((f) => f.envKey);
    if (allOverrideKeys.length === 0) return;
    if (confirm('确定要重置所有审查配置到默认值吗？这将立即生效。')) {
      resetMutation.mutate(allOverrideKeys);
    }
  };

  // Derived: visible fields for the current engine
  const visibleReviewFields = useMemo(
    () => (reviewGroup ? getVisibleFields(engine, reviewGroup.fields) : []),
    [engine, reviewGroup]
  );

  const hasOverrides = useMemo(() => {
    const groups = [reviewGroup, memoryGroup].filter(Boolean) as ConfigGroupDto[];
    return groups.some((g) => g.fields.some((f) => f.source === 'db'));
  }, [reviewGroup, memoryGroup]);

  // -- Render states --

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center mb-6">
          <Skeleton className="h-10 w-48 bg-muted/60" />
          <Skeleton className="h-10 w-24 bg-muted/60" />
        </div>
        <Skeleton className="h-[200px] w-full rounded-xl bg-muted/60 border border-border/60" />
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

  // Build a synthetic group for the visible review fields
  const syntheticReviewGroup: ConfigGroupDto | null = reviewGroup
    ? {
        ...reviewGroup,
          label: engine === 'codex' ? 'Codex 审查设置' : 'Kernel 审查设置',
        description:
          engine === 'codex'
            ? 'Codex CLI 审查引擎配置'
            : '基于 PR Session 的 agentic loop 审查引擎配置',
        fields: visibleReviewFields,
      }
    : null;

  /** Custom field renderer: CODEX_MODEL uses ModelCombobox for tokenlens suggestions. */
  const renderReviewField = engine === 'codex'
    ? (field: ConfigFieldDto, value: any, onChange: (val: any) => void) => {
        if (field.envKey !== CODEX_MODEL_FIELD) return undefined;
        // Replicate ConfigFieldInput layout with ModelCombobox as the input control
        const sourceBadge = field.source === 'db'
          ? <Badge className="ml-2 bg-primary/20 text-primary border-primary/30 tech-glow hover:bg-accent hover:text-foreground hover:border-border/70 transition-colors">已配置</Badge>
          : <Badge variant="outline" className="ml-2 border-border text-muted-foreground">默认值</Badge>;
        return (
          <div className="flex flex-col py-5 px-1 gap-3 hover:bg-accent/40 transition-colors rounded-lg">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex flex-col space-y-1.5 flex-1">
                <div className="flex items-center">
                  <label className="text-base font-semibold text-foreground">{field.label || field.envKey}</label>
                  {sourceBadge}
                </div>
                <div className="text-sm text-muted-foreground leading-relaxed">{field.description}</div>
                <div className="pt-1">
                  <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 inline-flex items-center">
                    {field.envKey}
                  </span>
                </div>
              </div>
              <div className="flex-1 w-full max-w-xl flex flex-col gap-2">
                <ModelCombobox
                  providerType="openai_compatible"
                  value={value ?? ''}
                  onChange={onChange}
                  placeholder="选择或输入模型..."
                />
              </div>
            </div>
          </div>
        );
      }
    : undefined;

  return (
    <div className="theme-page-frame">
      {/* Sticky action bar */}
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
        {/* Engine Selector Card */}
        <Card className="gap-0 py-0 theme-card-shell group">
          <CardHeader className="theme-card-header pb-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 tech-glow group-hover:bg-accent transition-all duration-300">
                <Layers className="h-5 w-5 text-primary" />
              </div>
              <div className="space-y-1">
                <CardTitle className="text-xl font-bold text-foreground tracking-tight">审查引擎</CardTitle>
                <CardDescription className="text-muted-foreground">选择代码审查引擎模式</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="theme-card-content">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ENGINE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleFieldChange(ENGINE_FIELD, opt.value)}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all duration-200 ${
                    engine === opt.value
                      ? 'border-primary/50 bg-primary/10 theme-glow-primary'
                      : 'border-border bg-muted/30 hover:bg-muted/50 hover:border-border'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-foreground">{opt.label}</span>
                    {engine === opt.value && (
                      <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">当前</Badge>
                    )}
                  </div>
                  <span className="text-sm text-muted-foreground">{opt.description}</span>
                  {engine === opt.value && (
                    <div className="absolute top-0 right-0 w-3 h-3 m-2 rounded-full bg-primary theme-glow-primary" />
                  )}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Engine-specific review config fields */}
        {syntheticReviewGroup && syntheticReviewGroup.fields.length > 0 && (
          <ConfigGroupCard
            group={syntheticReviewGroup}
            localConfig={localConfig}
            onFieldChange={handleFieldChange}
            onReset={handleResetGroup}
            isResetting={resetMutation.isPending}
            renderField={renderReviewField}
          />
        )}

        {engine === 'kernel' && memoryGroup && (
          <ConfigGroupCard
            group={memoryGroup}
            localConfig={localConfig}
            onFieldChange={handleFieldChange}
            onReset={handleResetGroup}
            isResetting={resetMutation.isPending}
          />
        )}

        {engine === 'kernel' && (
          <>
            <ProviderList />
            <RoleAssignment />
          </>
        )}
      </div>
    </div>
  );
}
