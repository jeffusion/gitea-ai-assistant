import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Save, ShieldCheck } from 'lucide-react';
import { fetchProviders, fetchRoles, setRole } from '@/services/llmProviderService';
import { ModelCombobox } from './ModelCombobox';

const ROLE_LABELS: Record<string, { label: string; desc: string }> = {
  planner: { label: '规划器 Planner', desc: '多阶段审查的第一步，负责分析上下文并分配任务' },
  specialist: { label: '专家 Specialist', desc: '执行深度代码审查的主力模型，专注于发现具体问题' },
  judge: { label: '评审 Judge', desc: '对专家的建议进行审核、合并和过滤，确保评论质量' },
  embedding: { label: '嵌入 Embedding', desc: '用于向量化代码和注释，支持语义搜索 (Qdrant)' },
};

const ROLES = ['planner', 'specialist', 'judge', 'embedding'];

interface RoleState {
  providerId: string | null;
  model: string;
}

export function RoleAssignment() {
  const queryClient = useQueryClient();
  const [roleStates, setRoleStates] = useState<Record<string, RoleState>>({});

  const { data: providers = [] } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: fetchProviders,
  });

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['llm-roles'],
    queryFn: fetchRoles,
  });

  useEffect(() => {
    if (roles.length > 0) {
      const initial: Record<string, RoleState> = {};
      roles.forEach(role => {
        initial[role.role] = {
          providerId: role.providerId,
          model: role.model || '',
        };
      });
      // Fill missing roles
      ROLES.forEach(r => {
        if (!initial[r]) {
          initial[r] = { providerId: null, model: '' };
        }
      });
      setRoleStates(initial);
    } else if (!isLoading) {
      const initial: Record<string, RoleState> = {};
      ROLES.forEach(r => {
        initial[r] = { providerId: null, model: '' };
      });
      setRoleStates(initial);
    }
  }, [roles, isLoading]);

  const saveMutation = useMutation({
    mutationFn: async ({ role, providerId, model }: { role: string; providerId: string | null; model: string | null }) => {
      return setRole(role, providerId, model);
    },
    onSuccess: (data) => {
      toast.success(`${ROLE_LABELS[data.role]?.label || data.role} 角色配置已保存`);
      queryClient.invalidateQueries({ queryKey: ['llm-roles'] });
    },
    onError: (error: unknown) => {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      toast.error(`保存失败: ${err?.response?.data?.error || err.message}`);
    }
  });

  const handleProviderChange = (role: string, providerId: string) => {
    const provider = providers.find(p => p.id === providerId);
    setRoleStates(prev => ({
      ...prev,
      [role]: {
        providerId,
        model: provider?.defaultModel || ''
      }
    }));
  };

  const handleModelChange = (role: string, model: string) => {
    setRoleStates(prev => ({
      ...prev,
      [role]: { ...prev[role], model }
    }));
  };

  const handleSave = (role: string) => {
    const state = roleStates[role];
    if (!state.providerId) {
      return toast.error('请选择提供商');
    }
    if (!state.model) {
      return toast.error('请输入模型名称');
    }
    saveMutation.mutate({
      role,
      providerId: state.providerId,
      model: state.model,
    });
  };

  const enabledProviders = providers.filter(p => p.isEnabled && p.hasKey);

  return (
    <Card className="glass-panel border-white/10 shadow-xl overflow-hidden group">
      <CardHeader className="flex flex-row items-center justify-between pb-4 space-y-0 border-b border-white/5 bg-zinc-950/30">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center border border-amber-500/20 group-hover:bg-amber-500/20 transition-all duration-300">
            <ShieldCheck className="h-5 w-5 text-amber-400" />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-xl font-bold text-zinc-100 tracking-tight">
              角色分配
            </CardTitle>
            <CardDescription className="text-zinc-400">
              为 AI 审查系统的不同角色指定提供商和模型
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-6 bg-zinc-950/20">
        {isLoading ? (
          <div className="h-32 flex items-center justify-center text-zinc-500 gap-2">
            <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            加载角色配置...
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {ROLES.map(role => {
              const state = roleStates[role] || { providerId: null, model: '' };
              const isDirty = roles.find(r => r.role === role)?.providerId !== state.providerId || 
                             (roles.find(r => r.role === role)?.model || '') !== state.model;
              
              return (
                <div key={role} className="flex flex-col md:flex-row items-start md:items-center gap-4 py-5 px-1 hover:bg-zinc-900/30 transition-colors rounded-lg">
                  <div className="w-full md:w-1/3 space-y-1.5">
                    <Label className="text-base font-semibold text-zinc-100">
                      {ROLE_LABELS[role]?.label || role}
                    </Label>
                    <p className="text-sm text-zinc-400 leading-relaxed">
                      {ROLE_LABELS[role]?.desc}
                    </p>
                  </div>
                  
                  <div className="w-full md:w-2/3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                    <div className="flex-1 w-full space-y-1">
                      <Label className="text-xs text-zinc-400">提供商</Label>
                      <Select 
                        value={state.providerId || ''} 
                        onValueChange={(v) => handleProviderChange(role, v)}
                      >
                        <SelectTrigger className="bg-zinc-900/50 border-white/10 text-white">
                          <SelectValue placeholder="选择提供商" />
                        </SelectTrigger>
                        <SelectContent className="bg-zinc-950 border-white/10 text-white">
                          {enabledProviders.map(p => (
                            <SelectItem key={p.id} value={p.id} description={p.type} className="focus:bg-zinc-900 focus:text-primary">
                              {p.name}
                            </SelectItem>
                          ))}
                          {enabledProviders.length === 0 && (
                            <div className="px-2 py-3 text-xs text-red-400 text-center border-t border-white/5">
                              无可用提供商。请先添加并启用。
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex-1 w-full space-y-1">
                      <Label className="text-xs text-zinc-400">使用的模型</Label>
                      <ModelCombobox
                        providerType={providers.find(p => p.id === state.providerId)?.type}
                        value={state.model}
                        onChange={(model) => handleModelChange(role, model)}
                        placeholder="选择或输入模型..."
                        disabled={!state.providerId}
                        className="w-full"
                      />
                    </div>

                    <div className="pt-5 flex-shrink-0">
                      <Button 
                        size="sm"
                        onClick={() => handleSave(role)}
                        disabled={!isDirty || saveMutation.isPending}
                        variant={isDirty ? 'default' : 'secondary'}
                        className={`transition-all ${isDirty ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30' : 'bg-white/5 text-zinc-500 border border-transparent'}`}
                      >
                        <Save className="w-4 h-4 mr-1.5" />
                        {isDirty ? '保存更改' : '已保存'}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
