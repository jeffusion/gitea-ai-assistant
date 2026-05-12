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
import { toast } from 'sonner';
import { Bot, Route, Save, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import {
  fetchKernelSubagents,
  fetchProviders,
  fetchRoles,
  setRole,
  type KernelSubagentDto,
} from '@/services/llmProviderService';
import { ModelCombobox } from './ModelCombobox';

const ROLE_LABELS: Record<string, { label: string; desc: string }> = {
  planner: { label: 'Planner', desc: '用于 triage / planning / context compression，负责审查分流与上下文压缩' },
  specialist: { label: 'Specialist', desc: '用于 correctness / security / quality 等深度审查' },
};

const ROLES = ['planner', 'specialist'];

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
              Subagents 与模型路由
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              上层展示 subagent 目录，下层配置 Planner / Specialist 模型路由
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="theme-card-content space-y-8">
        {/* ── Subagents 目录 ──────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold text-foreground">Subagents 目录</h3>
          </div>

          <Alert className="border-primary/20 bg-primary/5">
            <Bot className="h-4 w-4 text-primary" />
            <AlertTitle>流程编排由 kernel 自动驱动</AlertTitle>
            <AlertDescription>
              kernel 根据 session state 与 planner 选择注册式 subagent 执行。下方展示的是当前已注册的 subagent 及其能力标签。
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
        </section>

        <Separator />

        {/* ── 模型角色路由 ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-warning/25 bg-warning/10 text-warning">
              <Workflow className="h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold text-foreground">模型角色路由</h3>
          </div>

          <Alert className="border-warning/20 bg-warning/5">
            <ShieldCheck className="h-4 w-4 text-warning" />
            <AlertTitle>这里配置的是底层模型路由，不是流程角色编排</AlertTitle>
            <AlertDescription>
              Planner / Specialist 决定由哪个 provider/model 响应 LLM 调用。subagent 的注册、标签和执行顺序由 kernel 控制。
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
        </section>
      </CardContent>
    </Card>
  );
}
