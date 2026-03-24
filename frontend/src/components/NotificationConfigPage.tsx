import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchConfig,
  fetchNotificationTestHistory,
  updateConfig,
  resetConfig,
  testNotification,
  type NotificationTestProvider,
} from '@/services/configService';
import type {
  ConfigResponse,
  ConfigGroupDto,
  ConfigFieldDto,
  NotificationTestRecordDto,
} from '@/services/configService';
import { ConfigGroupCard } from './ConfigGroupCard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Save, AlertCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

const NOTIFICATION_GROUPS = new Set(['notification']);

type ProviderCardMeta = {
  key: NotificationTestProvider;
  fieldPrefix: 'FEISHU_' | 'WECOM_';
  label: string;
  description: string;
  enableKey: 'FEISHU_ENABLED' | 'WECOM_ENABLED';
  webhookKey: 'FEISHU_WEBHOOK_URL' | 'WECOM_WEBHOOK_URL';
};

const PROVIDER_CARDS: ProviderCardMeta[] = [
  {
    key: 'feishu',
    fieldPrefix: 'FEISHU_',
    label: '飞书通知',
    description: '配置飞书机器人 Webhook 与签名密钥。',
    enableKey: 'FEISHU_ENABLED',
    webhookKey: 'FEISHU_WEBHOOK_URL',
  },
  {
    key: 'wecom',
    fieldPrefix: 'WECOM_',
    label: '企业微信通知',
    description: '配置企业微信群机器人 Webhook。',
    enableKey: 'WECOM_ENABLED',
    webhookKey: 'WECOM_WEBHOOK_URL',
  },
];

export function NotificationConfigPage() {
  const queryClient = useQueryClient();
  const [localConfig, setLocalConfig] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const { data, isLoading, isError, error } = useQuery<ConfigResponse, Error>({
    queryKey: ['config'],
    queryFn: fetchConfig,
  });

  const {
    data: testHistory,
    isLoading: isHistoryLoading,
  } = useQuery<NotificationTestRecordDto[], Error>({
    queryKey: ['notification-test-history'],
    queryFn: fetchNotificationTestHistory,
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (data) {
      const initialState: Record<string, any> = {};
      data.groups
        .filter((g) => NOTIFICATION_GROUPS.has(g.key))
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
      toast.success('通知配置已成功保存');
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setHasChanges(false);
    },
    onError: (err: Error) => {
      toast.error(`保存失败: ${err.message}`);
    },
  });

  const feishuTestMutation = useMutation({
    mutationFn: () => testNotification('feishu'),
    onSuccess: () => {
      toast.success('飞书测试通知已发送');
      queryClient.invalidateQueries({ queryKey: ['notification-test-history'] });
    },
    onError: (err: Error) => {
      toast.error(`飞书测试发送失败: ${err.message}`);
      queryClient.invalidateQueries({ queryKey: ['notification-test-history'] });
    },
  });

  const wecomTestMutation = useMutation({
    mutationFn: () => testNotification('wecom'),
    onSuccess: () => {
      toast.success('企业微信测试通知已发送');
      queryClient.invalidateQueries({ queryKey: ['notification-test-history'] });
    },
    onError: (err: Error) => {
      toast.error(`企业微信测试发送失败: ${err.message}`);
      queryClient.invalidateQueries({ queryKey: ['notification-test-history'] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: (keys: string[]) => resetConfig(keys),
    onSuccess: () => {
      toast.success('通知配置已重置');
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
    if (confirm('确定要重置这些通知配置到默认值吗？这将立即生效。')) {
      resetMutation.mutate(keys);
    }
  };

  const notificationGroup = useMemo(
    () => data?.groups.find((g) => NOTIFICATION_GROUPS.has(g.key)),
    [data]
  );

  const providerGroups = useMemo<ConfigGroupDto[]>(() => {
    if (!notificationGroup) {
      return [];
    }

    return PROVIDER_CARDS.map((provider) => {
      const fields = notificationGroup.fields.filter((field: ConfigFieldDto) =>
        field.envKey.startsWith(provider.fieldPrefix)
      );

      return {
        ...notificationGroup,
        key: `notification-${provider.key}`,
        label: provider.label,
        description: provider.description,
        fields,
      };
    }).filter((group) => group.fields.length > 0);
  }, [notificationGroup]);

  const hasOverrides = useMemo(
    () =>
      providerGroups.some((g) =>
        g.fields.some((f) => f.source === 'db')
      ),
    [providerGroups]
  );

  const handleResetAll = () => {
    if (providerGroups.length === 0) return;
    const allOverrideKeys = providerGroups
      .flatMap((g) => g.fields)
      .filter((f) => f.source === 'db')
      .map((f) => f.envKey);

    if (allOverrideKeys.length === 0) return;
    if (confirm('确定要重置所有通知配置到默认值吗？这将立即生效。')) {
      resetMutation.mutate(allOverrideKeys);
    }
  };

  const canSendProviderTest = (provider: ProviderCardMeta): boolean => {
    const enabled = localConfig[provider.enableKey] === true;
    const webhook = localConfig[provider.webhookKey];
    return enabled && typeof webhook === 'string' && webhook.trim().length > 0;
  };

  const getProviderMutation = (providerKey: NotificationTestProvider) => {
    return providerKey === 'feishu' ? feishuTestMutation : wecomTestMutation;
  };

  const getProviderLabel = (provider: string): string => {
    if (provider === 'feishu') return '飞书';
    if (provider === 'wecom') return '企业微信';
    return provider;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center mb-6">
          <Skeleton className="h-10 w-48 bg-muted/60" />
          <Skeleton className="h-10 w-24 bg-muted/60" />
        </div>
        <Skeleton className="h-[280px] w-full rounded-xl bg-muted/60 border border-border/60" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="theme-error-panel flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-danger" />
        <div className="font-medium tracking-wide">加载通知配置失败: {error.message}</div>
      </div>
    );
  }

  return (
    <div className="theme-page-frame">
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
        {providerGroups.map((group) => {
          const provider = PROVIDER_CARDS.find((item) => group.key === `notification-${item.key}`);
          if (!provider) {
            return null;
          }

          const mutation = getProviderMutation(provider.key);
          const canTest = canSendProviderTest(provider);
          const canTestNow = canTest && !hasChanges && !saveMutation.isPending;
          const testTitle = hasChanges
            ? '请先保存配置后再测试'
            : canTest
              ? '发送测试通知'
              : '请先启用并配置Webhook地址';

          return (
            <ConfigGroupCard
              key={group.key}
              group={group}
              localConfig={localConfig}
              onFieldChange={handleFieldChange}
              onReset={handleResetGroup}
              isResetting={resetMutation.isPending}
              headerActions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => mutation.mutate()}
                  disabled={mutation.isPending || !canTestNow}
                  className="theme-interactive-elevate border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                  title={testTitle}
                >
                  {mutation.isPending ? '测试中...' : '测试发送'}
                </Button>
              }
            />
          );
        })}

        <div className="rounded-xl border border-border/60 bg-card p-4 md:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold tracking-wide text-foreground">最近测试记录</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['notification-test-history'] })}
              className="theme-interactive-elevate border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            >
              刷新
            </Button>
          </div>

          {isHistoryLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full bg-muted/60" />
              <Skeleton className="h-10 w-full bg-muted/60" />
            </div>
          ) : (testHistory?.length ?? 0) === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
              暂无测试记录，点击上方“测试发送”按钮可生成记录。
            </div>
          ) : (
            <div className="space-y-2">
              {testHistory?.slice(0, 10).map((record) => (
                <div
                  key={record.id}
                  className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-border text-foreground">
                      {getProviderLabel(record.provider)}
                    </Badge>
                    <Badge
                      className={
                        record.status === 'success'
                          ? 'bg-success/15 text-success border-success/30'
                          : 'bg-danger/15 text-danger border-danger/30'
                      }
                    >
                      {record.status === 'success' ? '成功' : '失败'}
                    </Badge>
                    <span className="text-sm text-muted-foreground">{record.message}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(record.timestamp).toLocaleString('zh-CN')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
