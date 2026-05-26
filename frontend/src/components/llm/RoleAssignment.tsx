import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, updateConfig } from '@/services/configService';
import type { ConfigResponse, ConfigFieldDto } from '@/services/configService';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Save, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export function RoleAssignment() {
  const queryClient = useQueryClient();
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);

  const { data, isLoading, isError, error } = useQuery<ConfigResponse, Error>({
    queryKey: ['config'],
    queryFn: fetchConfig,
  });

  const REQUIRED_KEYS = [
    'AGENT_MAIN_MODEL',
    'AGENT_DEFAULT_SUBAGENT_MODEL',
    'LLM_MAX_CONCURRENT_CALLS',
    'LLM_RETRY_MAX_ATTEMPTS',
    'LLM_RETRY_BASE_DELAY_MS',
  ];

  const fieldsMap = useMemo(() => {
    if (!data) return new Map<string, ConfigFieldDto>();
    const map = new Map<string, ConfigFieldDto>();
    data.groups.forEach((group) => {
      group.fields.forEach((field) => {
        map.set(field.envKey, field);
      });
    });
    return map;
  }, [data]);

  useEffect(() => {
    if (data) {
      const initialValues: Record<string, string> = {};
      REQUIRED_KEYS.forEach((key) => {
        const field = fieldsMap.get(key);
        if (field) {
          initialValues[key] = String(field.value ?? field.defaultValue ?? '');
        } else {
          initialValues[key] = '';
        }
      });
      setLocalValues(initialValues);
      setIsDirty(false);
    }
  }, [data, fieldsMap]);

  const saveMutation = useMutation({
    mutationFn: (configData: Record<string, string>) => updateConfig(configData),
    onSuccess: () => {
      toast.success('智能体模型设置已保存');
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setIsDirty(false);
    },
    onError: (err: Error) => {
      toast.error(`保存失败: ${err.message}`);
    },
  });

  const handleFieldChange = (key: string, value: string) => {
    setLocalValues((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const handleSave = () => {
    const payload: Record<string, string> = {};
    REQUIRED_KEYS.forEach((key) => {
      payload[key] = localValues[key] ?? '';
    });
    saveMutation.mutate(payload);
  };

  if (isLoading) {
    return (
      <Card className="gap-0 py-0 theme-card-shell group">
        <CardHeader className="theme-card-header pb-4">
          <CardTitle className="text-xl font-bold text-foreground tracking-tight">
            智能体模型设置
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            加载配置中...
          </CardDescription>
        </CardHeader>
        <CardContent className="theme-card-content flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="gap-0 py-0 theme-card-shell group">
        <CardHeader className="theme-card-header pb-4">
          <CardTitle className="text-xl font-bold text-foreground tracking-tight">
            智能体模型设置
          </CardTitle>
        </CardHeader>
        <CardContent className="theme-card-content">
          <div className="theme-error-panel flex items-center gap-3 text-danger">
            <AlertCircle className="w-5 h-5" />
            <div className="font-medium tracking-wide">加载配置失败: {error.message}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const missingKeys = REQUIRED_KEYS.filter((key) => !fieldsMap.has(key));

  return (
    <Card className="gap-0 py-0 theme-card-shell group">
      <CardHeader className="theme-card-header pb-4 flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-xl font-bold text-foreground tracking-tight">
            智能体模型设置
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            管理智能体运行时的主模型、子模型以及 LLM 调用弹性设置。
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={!isDirty || saveMutation.isPending}
            className="theme-interactive-elevate min-w-[100px] bg-primary text-primary-foreground font-bold hover:bg-primary/90 tech-glow transition-all"
          >
            {saveMutation.isPending ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> 保存中...
              </span>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                保存设置
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="theme-card-content space-y-6">
        {missingKeys.length > 0 && (
          <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <span className="font-semibold">部分配置项在系统中不可用：</span>
              <span className="font-mono text-xs">{missingKeys.join(', ')}</span>。这些设置将无法编辑或保存。
            </div>
          </div>
        )}

        <div className="space-y-4">
          {REQUIRED_KEYS.map((key) => {
            const field = fieldsMap.get(key);
            const isAvailable = !!field;
            const label = field?.label || key;
            const description = field?.description || '系统未提供该配置项的描述。';
            const type = field?.type === 'number' ? 'number' : 'text';

            return (
              <div
                key={key}
                className={`flex flex-col gap-2 p-4 rounded-lg border transition-colors ${
                  isAvailable
                    ? 'border-border hover:bg-accent/20'
                    : 'border-dashed border-muted bg-muted/10 opacity-60'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="flex flex-col space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={key} className="text-base font-semibold text-foreground cursor-pointer">
                        {label}
                      </Label>
                      {!isAvailable && (
                        <Badge variant="outline" className="border-danger/30 text-danger bg-danger/5">
                          不可用
                        </Badge>
                      )}
                      {isAvailable && field.source === 'db' && (
                        <Badge className="bg-primary/20 text-primary border-primary/30 tech-glow">
                          已配置
                        </Badge>
                      )}
                      {isAvailable && field.source === 'default' && (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          默认值
                        </Badge>
                      )}
                    </div>
                    <span className="text-sm text-muted-foreground leading-relaxed">
                      {description}
                    </span>
                    <div className="pt-1">
                      <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 inline-flex items-center">
                        {key}
                      </span>
                    </div>
                  </div>

                  <div className="flex-1 w-full max-w-xl flex flex-col gap-2">
                    <Input
                      id={key}
                      type={type}
                      value={localValues[key] ?? ''}
                      onChange={(e) => handleFieldChange(key, e.target.value)}
                      disabled={!isAvailable || saveMutation.isPending}
                      placeholder={!isAvailable ? '配置项不可用' : `请输入 ${label}...`}
                      className="bg-muted/50 border-border focus-visible:ring-primary focus-visible:border-primary transition-all duration-200"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
