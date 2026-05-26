import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from '@/components/ui/table';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Edit2, Trash2, Play, Plus, Activity } from 'lucide-react';
import { fetchProviders, updateProvider, deleteProvider, testProvider } from '@/services/llmProviderService';
import type { ProviderDto, TestResult } from '@/services/llmProviderService';
import { ProviderDialog } from './ProviderDialog';
import { TestResultDialog } from './TestResultDialog';

const TYPE_LABELS: Record<string, string> = {
  openai_compatible: 'OpenAI 兼容',
  openai_responses: 'OpenAI Responses',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

const TYPE_COLORS: Record<string, string> = {
  openai_compatible: 'bg-success/10 text-success border-success/20',
  openai_responses: 'bg-info/10 text-info border-info/20',
  anthropic: 'bg-warning/10 text-warning border-warning/20',
  gemini: 'bg-primary/10 text-primary border-primary/20',
};

export function ProviderList() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderDto | undefined>(undefined);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testProviderName, setTestProviderName] = useState<string>('');

  const { data: providers = [], isLoading } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: fetchProviders,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isEnabled }: { id: string; isEnabled: boolean }) => {
      return updateProvider(id, { isEnabled });
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['llm-providers'] });
      const previousProviders = queryClient.getQueryData<ProviderDto[]>(['llm-providers']);
      queryClient.setQueryData<ProviderDto[]>(['llm-providers'], old => 
        old?.map(p => p.id === variables.id ? { ...p, isEnabled: variables.isEnabled } : p)
      );
      return { previousProviders };
    },
    onError: (_err, _variables, context) => {
      queryClient.setQueryData(['llm-providers'], context?.previousProviders);
      toast.error('切换状态失败');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProvider,
    onSuccess: () => {
      toast.success('已删除提供商');
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
    },
    onError: (error: unknown) => {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      toast.error(`删除失败: ${err?.response?.data?.error || err.message}`);
    }
  });

  const handleToggle = (provider: ProviderDto) => {
    toggleMutation.mutate({ id: provider.id, isEnabled: !provider.isEnabled });
  };

  const handleDelete = (provider: ProviderDto) => {
    if (!window.confirm(`确定要删除提供商 "${provider.name}" 吗？`)) {
      return;
    }
    deleteMutation.mutate(provider.id);
  };

  const handleTest = async (provider: ProviderDto) => {
    try {
      setTestingId(provider.id);
      const result = await testProvider(provider.id);
      setTestResult(result);
      setTestProviderName(provider.name);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      toast.error('测试请求失败', {
        description: err?.response?.data?.error || err.message
      });
    } finally {
      setTestingId(null);
    }
  };

  const openAdd = () => {
    setEditingProvider(undefined);
    setDialogOpen(true);
  };

  const openEdit = (provider: ProviderDto) => {
    setEditingProvider(provider);
    setDialogOpen(true);
  };

  return (
    <>
      <Card className="gap-0 py-0 theme-card-shell group">
        <CardHeader className="theme-card-header flex flex-row items-center justify-between pb-4 space-y-0">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 tech-glow group-hover:bg-accent transition-all duration-300">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-xl font-bold text-foreground tracking-tight">
                模型提供商
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                管理连接的 LLM API 服务及其访问密钥
              </CardDescription>
            </div>
          </div>
          <Button onClick={openAdd} className="bg-primary text-primary-foreground hover:bg-primary/90 theme-glow-primary transition-all">
            <Plus className="w-4 h-4 mr-2" />
            添加提供商
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="text-muted-foreground font-medium h-12">名称</TableHead>
                <TableHead className="text-muted-foreground font-medium h-12">类型</TableHead>
                <TableHead className="text-muted-foreground font-medium h-12">默认模型</TableHead>
                <TableHead className="text-muted-foreground font-medium h-12 text-center">状态</TableHead>
                <TableHead className="text-muted-foreground font-medium h-12 text-center">启用</TableHead>
                <TableHead className="text-muted-foreground font-medium h-12 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow className="border-border/60 hover:bg-muted/30">
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      加载中...
                    </div>
                  </TableCell>
                </TableRow>
              ) : providers.length === 0 ? (
                <TableRow className="border-border/60 hover:bg-muted/30">
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    暂无提供商配置，请点击右上角添加。
                  </TableCell>
                </TableRow>
              ) : (
                providers.map(provider => (
                  <TableRow key={provider.id} className="border-border/60 hover:bg-muted/30 transition-colors">
                    <TableCell className="font-medium text-foreground">
                      {provider.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-normal ${TYPE_COLORS[provider.type] || 'text-muted-foreground'}`}>
                        {TYPE_LABELS[provider.type] || provider.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-foreground/90">
                      <code className="bg-muted/60 px-1.5 py-0.5 rounded text-xs text-primary/80">
                        {provider.defaultModel}
                      </code>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1.5" title={provider.hasKey ? '已配置 API Key' : '未配置 API Key'}>
                        <span className={`w-2 h-2 rounded-full ${provider.hasKey ? 'bg-success theme-glow-success' : 'bg-muted-foreground/60'}`} />
                        <span className="text-xs text-muted-foreground">{provider.hasKey ? '就绪' : '无 Key'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch 
                        checked={provider.isEnabled} 
                        onCheckedChange={() => handleToggle(provider)}
                        className="data-[state=checked]:bg-primary"
                      />
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => handleTest(provider)}
                        disabled={testingId === provider.id || !provider.hasKey}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        title="测试连接"
                      >
                        {testingId === provider.id ? (
                          <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => openEdit(provider)}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        title="编辑"
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => handleDelete(provider)}
                        className="h-8 w-8 text-muted-foreground hover:text-danger hover:bg-danger/10 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ProviderDialog 
        open={dialogOpen} 
        onOpenChange={setDialogOpen} 
        provider={editingProvider} 
      />

      <TestResultDialog
        open={!!testResult}
        onOpenChange={(open) => !open && setTestResult(null)}
        result={testResult}
        providerName={testProviderName}
      />
    </>
  );
}
