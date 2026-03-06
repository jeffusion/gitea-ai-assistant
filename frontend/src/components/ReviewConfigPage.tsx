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

type EngineMode = 'legacy' | 'agent' | 'codex';

/** The engine selector field — always visible at the top. */
const ENGINE_FIELD = 'REVIEW_ENGINE';

/** Fields shared across legacy & agent (but NOT codex). */
const LEGACY_AGENT_FIELDS = new Set([
  'CUSTOM_SUMMARY_PROMPT',
  'CUSTOM_LINE_COMMENT_PROMPT',
  'GLOBAL_PROMPT',
  'REVIEW_WORKDIR',
  'REVIEW_MAX_PARALLEL_RUNS',
  'REVIEW_MAX_FILES_PER_RUN',
  'REVIEW_MAX_FILE_CONTENT_CHARS',
]);

/** Fields specific to agent mode only. */
const AGENT_ONLY_FIELDS = new Set([
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
      case 'legacy':
        return LEGACY_AGENT_FIELDS.has(f.envKey);
      case 'agent':
        return LEGACY_AGENT_FIELDS.has(f.envKey) || AGENT_ONLY_FIELDS.has(f.envKey);
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
  { value: 'legacy', label: 'Legacy', description: '传统单次 LLM 审查' },
  { value: 'agent', label: 'Agent', description: '多代理编排深度审查' },
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
    if (val === 'agent' || val === 'codex') return val;
    return 'legacy';
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
          <Skeleton className="h-10 w-48 bg-zinc-900/50" />
          <Skeleton className="h-10 w-24 bg-zinc-900/50" />
        </div>
        <Skeleton className="h-[200px] w-full rounded-xl bg-zinc-900/50 border border-white/5" />
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

  // Build a synthetic group for the visible review fields
  const syntheticReviewGroup: ConfigGroupDto | null = reviewGroup
    ? {
        ...reviewGroup,
        label: engine === 'codex' ? 'Codex 审查设置' : engine === 'agent' ? 'Agent 审查设置' : 'Legacy 审查设置',
        description:
          engine === 'codex'
            ? 'Codex CLI 审查引擎配置'
            : engine === 'agent'
              ? '多代理编排审查引擎配置'
              : '传统单次 LLM 审查引擎配置',
        fields: visibleReviewFields,
      }
    : null;

  /** Custom field renderer: CODEX_MODEL uses ModelCombobox for tokenlens suggestions. */
  const renderReviewField = engine === 'codex'
    ? (field: ConfigFieldDto, value: any, onChange: (val: any) => void) => {
        if (field.envKey !== CODEX_MODEL_FIELD) return undefined;
        // Replicate ConfigFieldInput layout with ModelCombobox as the input control
        const sourceBadge = field.source === 'db'
          ? <Badge className="ml-2 bg-primary/20 text-primary border-primary/30 tech-glow hover:bg-primary/30 transition-colors">已配置</Badge>
          : <Badge variant="outline" className="ml-2 border-zinc-600 text-zinc-400">默认值</Badge>;
        return (
          <div className="flex flex-col py-5 px-1 gap-3 hover:bg-zinc-900/30 transition-colors rounded-lg">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex flex-col space-y-1.5 flex-1">
                <div className="flex items-center">
                  <label className="text-base font-semibold text-zinc-100">{field.label || field.envKey}</label>
                  {sourceBadge}
                </div>
                <div className="text-sm text-zinc-400 leading-relaxed">{field.description}</div>
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
    <div className="min-h-screen pb-12">
      {/* Sticky action bar */}
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
        {/* Engine Selector Card */}
        <Card className="glass-panel border-white/10 shadow-xl overflow-hidden group">
          <CardHeader className="border-b border-white/5 bg-zinc-950/30 pb-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 tech-glow group-hover:bg-primary/20 transition-all duration-300">
                <Layers className="h-5 w-5 text-primary" />
              </div>
              <div className="space-y-1">
                <CardTitle className="text-xl font-bold text-zinc-100 tracking-tight">审查引擎</CardTitle>
                <CardDescription className="text-zinc-400">选择代码审查引擎模式</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 bg-zinc-950/20">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {ENGINE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleFieldChange(ENGINE_FIELD, opt.value)}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all duration-200 ${
                    engine === opt.value
                      ? 'border-primary/50 bg-primary/10 shadow-[0_0_20px_rgba(20,184,166,0.15)]'
                      : 'border-white/10 bg-zinc-900/30 hover:bg-zinc-900/50 hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-zinc-100">{opt.label}</span>
                    {engine === opt.value && (
                      <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">当前</Badge>
                    )}
                  </div>
                  <span className="text-sm text-zinc-400">{opt.description}</span>
                  {engine === opt.value && (
                    <div className="absolute top-0 right-0 w-3 h-3 m-2 rounded-full bg-primary shadow-[0_0_10px_rgba(20,184,166,0.6)]" />
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

        {/* Memory group — agent mode only */}
        {engine === 'agent' && memoryGroup && (
          <ConfigGroupCard
            group={memoryGroup}
            localConfig={localConfig}
            onFieldChange={handleFieldChange}
            onReset={handleResetGroup}
            isResetting={resetMutation.isPending}
          />
        )}

        {/* LLM Provider config — legacy & agent only */}
        {engine !== 'codex' && (
          <>
            <ProviderList />
            <RoleAssignment />
          </>
        )}
      </div>
    </div>
  );
}
