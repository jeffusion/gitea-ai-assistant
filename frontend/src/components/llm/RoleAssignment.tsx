import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Bot, GitBranch, Route, Save, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import {
  fetchKernelSubagents,
  fetchProviders,
  fetchRoles,
  setRole,
  type KernelSubagentDto,
} from '@/services/llmProviderService';
import { ModelCombobox } from './ModelCombobox';

const ROLE_LABELS: Record<string, { label: string; desc: string }> = {
  planner: { label: 'Planner', desc: '用于 triage / planning 子代理，负责生成审查任务切片' },
  specialist: { label: 'Specialist', desc: '用于专项 subagent，负责 correctness/security 等深度审查' },
  judge: { label: 'Judge', desc: '用于裁决类 subagent，负责 findings 汇总、过滤与结论收敛' },
  embedding: { label: '嵌入 Embedding', desc: '用于向量化代码和注释，支持语义搜索 (Qdrant)' },
};

const ROLES = ['planner', 'specialist', 'judge', 'embedding'];

interface RoleState {
  providerId: string | null;
  model: string;
}

function getModelRoleBadgeClass(modelRole?: string): string {
  switch (modelRole) {
    case 'planner':
      return 'border-info/30 bg-info/10 text-info';
    case 'specialist':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'judge':
      return 'border-success/30 bg-success/10 text-success';
    case 'embedding':
      return 'border-warning/30 bg-warning/10 text-warning';
    default:
      return 'border-border bg-muted/40 text-muted-foreground';
  }
}

function getSourceBadgeClass(source: KernelSubagentDto['source']): string {
  switch (source) {
    case 'built-in':
      return 'border-primary/20 bg-primary/10 text-primary';
    case 'plugin':
      return 'border-warning/20 bg-warning/10 text-warning';
    case 'custom':
      return 'border-success/20 bg-success/10 text-success';
    default:
      return 'border-border bg-muted/40 text-muted-foreground';
  }
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

  const { data: subagents = [], isLoading: isSubagentsLoading } = useQuery({
    queryKey: ['kernel-subagents'],
    queryFn: fetchKernelSubagents,
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
    <Card className="gap-0 py-0 theme-card-shell group">
      <CardHeader className="theme-card-header flex flex-row items-center justify-between pb-4 space-y-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-warning/10 flex items-center justify-center border border-warning/20 group-hover:bg-warning/20 transition-all duration-300">
            <ShieldCheck className="h-5 w-5 text-warning" />
          </div>
            <div className="space-y-1">
              <CardTitle className="text-xl font-bold text-foreground tracking-tight">
                Subagents 与模型角色路由
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                适配 kernel 架构：上层展示注册式 subagent 目录，下层配置底层模型角色路由
              </CardDescription>
            </div>
          </div>
      </CardHeader>

      <CardContent className="theme-card-content">
        <Tabs defaultValue="subagents" className="space-y-5">
          <TabsList className="grid h-auto w-full grid-cols-1 gap-3 rounded-[28px] border border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,248,250,0.92))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_8px_24px_rgba(15,23,42,0.06)] md:grid-cols-2 dark:bg-[linear-gradient(180deg,rgba(24,24,27,0.92),rgba(15,23,42,0.84))]">
            <TabsTrigger
              value="subagents"
              className="group h-auto min-h-[88px] justify-start whitespace-normal rounded-[22px] border border-transparent px-5 py-4 text-left data-[state=active]:border-primary/30 data-[state=active]:bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(236,244,255,0.95))] data-[state=active]:text-foreground data-[state=active]:shadow-[0_10px_30px_rgba(37,99,235,0.12)] dark:data-[state=active]:bg-[linear-gradient(180deg,rgba(30,41,59,0.95),rgba(15,23,42,0.92))]"
            >
              <div className="flex w-full items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary transition-transform duration-300 group-data-[state=active]:scale-105 group-data-[state=active]:shadow-[0_0_0_6px_rgba(59,130,246,0.08)]">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="text-base font-semibold tracking-tight text-foreground">Subagents 目录</div>
                  <div className="max-w-full whitespace-normal break-words text-xs leading-5 text-muted-foreground md:text-sm">
                    查看当前 kernel 已注册的 subagent、能力标签和模型角色绑定
                  </div>
                </div>
              </div>
            </TabsTrigger>
            <TabsTrigger
              value="roles"
              className="group h-auto min-h-[88px] justify-start whitespace-normal rounded-[22px] border border-transparent px-5 py-4 text-left data-[state=active]:border-warning/30 data-[state=active]:bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(255,248,235,0.96))] data-[state=active]:text-foreground data-[state=active]:shadow-[0_10px_30px_rgba(245,158,11,0.14)] dark:data-[state=active]:bg-[linear-gradient(180deg,rgba(41,37,36,0.96),rgba(28,25,23,0.92))]"
            >
              <div className="flex w-full items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-warning/25 bg-warning/10 text-warning transition-transform duration-300 group-data-[state=active]:scale-105 group-data-[state=active]:shadow-[0_0_0_6px_rgba(245,158,11,0.08)]">
                  <Workflow className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="text-base font-semibold tracking-tight text-foreground">模型角色路由</div>
                  <div className="max-w-full whitespace-normal break-words text-xs leading-5 text-muted-foreground md:text-sm">
                    配置 planner / specialist / judge / embedding 走哪个 provider 与模型
                  </div>
                </div>
              </div>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="subagents" className="space-y-4">
            <Alert className="border-primary/20 bg-primary/5">
              <Bot className="h-4 w-4 text-primary" />
              <AlertTitle>现在的流程编排不再由“角色分配”驱动</AlertTitle>
              <AlertDescription>
                kernel 会根据 session state 与 planner 选择注册式 subagent。这里展示的是当前内核中已注册的 subagent 目录、能力标签和底层模型角色绑定。
              </AlertDescription>
            </Alert>

            {isSubagentsLoading ? (
              <div className="h-32 flex items-center justify-center text-muted-foreground gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                加载 subagent 目录...
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <Card className="border-border/70 bg-card/70">
                    <CardContent className="p-5">
                      <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Subagents</div>
                      <div className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{subagents.length}</div>
                    </CardContent>
                  </Card>
                  <Card className="border-border/70 bg-card/70">
                    <CardContent className="p-5">
                      <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Built-in</div>
                      <div className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
                        {subagents.filter((item) => item.source === 'built-in').length}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-border/70 bg-card/70">
                    <CardContent className="p-5">
                      <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">模型角色</div>
                      <div className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
                        {new Set(subagents.map((item) => item.modelRole).filter(Boolean)).size}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card className="border-border/70 bg-card/70">
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-5">Subagent</TableHead>
                          <TableHead>能力定位</TableHead>
                          <TableHead>模型角色</TableHead>
                          <TableHead>标签</TableHead>
                          <TableHead className="pr-5 text-right">状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {subagents.map((subagent) => (
                          <TableRow key={subagent.name}>
                            <TableCell className="pl-5 align-top">
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-foreground">{subagent.name}</span>
                                  <Badge className={getSourceBadgeClass(subagent.source)}>{subagent.source}</Badge>
                                </div>
                                <div className="text-sm text-muted-foreground">{subagent.description}</div>
                              </div>
                            </TableCell>
                            <TableCell className="align-top text-sm text-muted-foreground whitespace-normal">
                              {subagent.whenToUse}
                            </TableCell>
                            <TableCell className="align-top">
                              <Badge className={getModelRoleBadgeClass(subagent.modelRole)}>
                                <Route className="h-3 w-3" />
                                {subagent.modelRole ?? '未绑定'}
                              </Badge>
                            </TableCell>
                            <TableCell className="align-top">
                              <div className="flex flex-wrap gap-1.5 max-w-[260px]">
                                {subagent.tags.map((tag) => (
                                  <Badge key={tag} variant="outline" className="bg-muted/30">{tag}</Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="pr-5 align-top text-right">
                              <Badge className={subagent.resumable ? 'border-success/20 bg-success/10 text-success' : 'border-border bg-muted/40 text-muted-foreground'}>
                                {subagent.resumable ? '可恢复' : '一次性'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="roles" className="space-y-4">
            <Alert className="border-warning/20 bg-warning/5">
              <GitBranch className="h-4 w-4 text-warning" />
              <AlertTitle>这里配置的是模型角色路由，不是流程角色编排</AlertTitle>
              <AlertDescription>
                Planner / Specialist / Judge / Embedding 仅决定底层由哪个 provider/model 响应，对应 subagent 的注册、标签和执行顺序由 kernel 控制。
              </AlertDescription>
            </Alert>

            {isLoading ? (
              <div className="h-32 flex items-center justify-center text-muted-foreground gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                加载模型角色路由...
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {ROLES.map(role => {
                  const state = roleStates[role] || { providerId: null, model: '' };
                  const isDirty = roles.find(r => r.role === role)?.providerId !== state.providerId ||
                                 (roles.find(r => r.role === role)?.model || '') !== state.model;
                  const consumers = subagents.filter((item) => item.modelRole === role);

                  return (
                    <div key={role} className="py-5 px-1">
                      <div className="flex flex-col gap-4 rounded-lg border border-border/60 bg-card/40 p-4 hover:bg-accent/20 transition-colors">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Label className="text-base font-semibold text-foreground">
                              {ROLE_LABELS[role]?.label || role}
                            </Label>
                            <Badge variant="outline" className="bg-muted/30">
                              {consumers.length} 个 subagent
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {ROLE_LABELS[role]?.desc}
                          </p>
                          {consumers.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {consumers.map((item) => (
                                <Badge key={item.name} className="border-primary/15 bg-primary/5 text-primary">
                                  {item.name}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>

                        <Separator />

                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                          <div className="flex-1 w-full space-y-1">
                            <Label className="text-xs text-muted-foreground">提供商</Label>
                            <Select
                              value={state.providerId || ''}
                              onValueChange={(v) => handleProviderChange(role, v)}
                            >
                              <SelectTrigger className="bg-muted/50 border-border text-foreground">
                                <SelectValue placeholder="选择提供商" />
                              </SelectTrigger>
                              <SelectContent className="bg-popover border-border text-foreground">
                                {enabledProviders.map(p => (
                                  <SelectItem key={p.id} value={p.id} description={p.type} className="focus:bg-accent focus:text-primary">
                                    {p.name}
                                  </SelectItem>
                                ))}
                                {enabledProviders.length === 0 && (
                                  <div className="px-2 py-3 text-xs text-danger text-center border-t border-border/60">
                                    无可用提供商。请先添加并启用。
                                  </div>
                                )}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="flex-1 w-full space-y-1">
                            <Label className="text-xs text-muted-foreground">使用的模型</Label>
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
                              className={`transition-all ${isDirty ? 'bg-warning/15 text-warning border border-warning/30 hover:bg-warning/25' : 'bg-muted/50 text-muted-foreground border border-transparent'}`}
                            >
                              <Save className="w-4 h-4 mr-1.5" />
                              {isDirty ? '保存更改' : '已保存'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
