import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { configService, type ConfigData, type ConfigItem } from '@/services/configService';
import { toast } from 'sonner';
import { AlertCircle, Save, RotateCcw, CheckCircle } from 'lucide-react';

interface ConfigFormData {
  [key: string]: any;
}

export default function ConfigPage() {
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');
  const [formData, setFormData] = useState<ConfigFormData>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    try {
      setLoading(true);
      const data = await configService.getConfigs();
      setConfigData(data);

      // 初始化表单数据
      const initialFormData: ConfigFormData = {};
      Object.entries(data.all).forEach(([key, config]) => {
        initialFormData[key] = config.value;
      });
      setFormData(initialFormData);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to load configs:', error);
      toast.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleConfigChange = (key: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [key]: value
    }));

    // 检查是否有变更
    const hasChanged = Object.entries({ ...formData, [key]: value }).some(
      ([configKey, configValue]) => {
        const originalValue = configData?.all[configKey]?.value;
        return configValue !== originalValue;
      }
    );
    setHasChanges(hasChanged);
  };

  const handleSave = async () => {
    if (!configData || !hasChanges) return;

    try {
      setSaving(true);

      // 找出变更的配置
      const changedConfigs: Record<string, any> = {};
      Object.entries(formData).forEach(([key, value]) => {
        const originalValue = configData.all[key]?.value;
        if (value !== originalValue) {
          changedConfigs[key] = value;
        }
      });

      if (Object.keys(changedConfigs).length === 0) {
        setHasChanges(false);
        return;
      }

      await configService.batchUpdateConfigs(changedConfigs);

      // 重新加载配置
      await loadConfigs();

      toast.success('配置保存成功');
    } catch (error: any) {
      console.error('Failed to save configs:', error);
      toast.error(error.response?.data?.message || '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!configData) return;

    const originalFormData: ConfigFormData = {};
    Object.entries(configData.all).forEach(([key, config]) => {
      originalFormData[key] = config.value;
    });
    setFormData(originalFormData);
    setHasChanges(false);
  };

  const renderConfigField = (key: string, config: ConfigItem) => {
    const value = formData[key] || '';
    const isLongText = key.includes('PROMPT') || value.length > 100;

    return (
      <div key={key} className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={key}>{key}</Label>
          {config.requiresRestart && (
            <Badge variant="secondary" className="text-xs">
              需要重启
            </Badge>
          )}
          {config.hasEnvOverride && (
            <Badge variant="outline" className="text-xs">
              环境变量覆盖
            </Badge>
          )}
        </div>

        {isLongText ? (
          <Textarea
            id={key}
            value={value}
            onChange={(e) => handleConfigChange(key, e.target.value)}
            placeholder={config.description}
            className="min-h-[100px]"
          />
        ) : (
          <Input
            id={key}
            type={key.includes('URL') ? 'url' : 'text'}
            value={value}
            onChange={(e) => handleConfigChange(key, e.target.value)}
            placeholder={config.description}
          />
        )}

        <p className="text-sm text-muted-foreground">{config.description}</p>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div>正在加载配置...</div>
      </div>
    );
  }

  if (!configData) {
    return (
      <div className="flex items-center justify-center p-8">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            加载配置失败，请刷新页面重试
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">系统配置</h1>
          <p className="text-muted-foreground">
            管理应用的基础配置。标记为"需要重启"的配置修改后需要重启服务才能生效。
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges || saving}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            重置
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? (
              <>
                <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                保存中...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                保存配置
              </>
            )}
          </Button>
        </div>
      </div>

      {hasChanges && (
        <Alert className="mb-6">
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            您有未保存的配置更改。请点击"保存配置"按钮保存更改。
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        <TabsList className="grid grid-cols-4 w-full">
          {Object.entries(configData.grouped).map(([groupKey, group]) => (
            <TabsTrigger
              key={groupKey}
              value={groupKey}
              onClick={() => setActiveTab(groupKey)}
              data-state={activeTab === groupKey ? 'active' : 'inactive'}
            >
              {group.title}
            </TabsTrigger>
          ))}
        </TabsList>

        {Object.entries(configData.grouped).map(([groupKey, group]) => (
          <div key={groupKey} className={activeTab === groupKey ? '' : 'hidden'}>
            <Card>
              <CardHeader>
                <CardTitle>{group.title}</CardTitle>
                <CardDescription>{group.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {Object.entries(group.configs).map(([configKey, config]) =>
                  renderConfigField(configKey, config)
                )}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}