import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchReviewRuns, fetchReviewRunDetails } from '@/services/reviewSessionService';
import type { AgentSessionTree } from '@/services/reviewSessionService';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Bot, Cpu, Terminal, CheckCircle2, AlertCircle, 
  ChevronRight, ChevronDown, Clock, FileText, Layers, 
  AlertTriangle, CornerDownRight, HelpCircle, Info
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helper Components & Formatters
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'succeeded':
    case 'completed':
      return <Badge className="bg-success/20 text-success border-success/30">成功</Badge>;
    case 'failed':
      return <Badge className="bg-danger/20 text-danger border-danger/30">失败</Badge>;
    case 'running':
    case 'in_progress':
      return <Badge className="bg-primary/20 text-primary border-primary/30 animate-pulse">运行中</Badge>;
    case 'queued':
      return <Badge className="bg-warning/20 text-warning border-warning/30">排队中</Badge>;
    case 'ignored':
      return <Badge className="bg-muted text-muted-foreground border-border">已忽略</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function SeverityBadge({ severity }: { severity: 'high' | 'medium' | 'low' }) {
  switch (severity) {
    case 'high':
      return <Badge className="bg-danger/20 text-danger border-danger/30 font-bold">高</Badge>;
    case 'medium':
      return <Badge className="bg-warning/20 text-warning border-warning/30 font-bold">中</Badge>;
    case 'low':
      return <Badge className="bg-info/20 text-info border-info/30 font-bold">低</Badge>;
    default:
      return <Badge variant="outline">{severity}</Badge>;
  }
}

function formatDateTime(isoString?: string): string {
  if (!isoString) return '-';
  return new Date(isoString).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// ---------------------------------------------------------------------------
// Agent Session Tree Node Component
// ---------------------------------------------------------------------------

interface TreeNodeProps {
  session: AgentSessionTree;
  level: number;
  onSelectSession: (session: AgentSessionTree) => void;
  selectedSessionId?: string;
}

function AgentTreeNode({ session, level, onSelectSession, selectedSessionId }: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const hasChildren = session.invocations && session.invocations.some(inv => inv.childSession);
  const isSelected = selectedSessionId === session.id;

  return (
    <div className="flex flex-col w-full">
      {/* Node Row */}
      <div 
        onClick={() => onSelectSession(session)}
        className={`flex items-center justify-between p-3 rounded-xl border transition-all duration-200 cursor-pointer mb-2 ${
          isSelected 
            ? 'border-primary/50 bg-primary/10 theme-glow-primary' 
            : 'border-border/60 bg-muted/30 hover:bg-accent/40 hover:border-border'
        }`}
        style={{ marginLeft: `${level * 24}px` }}
      >
        <div className="flex items-center gap-3 min-w-0">
          {hasChildren ? (
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            >
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : (
            <div className="w-6 h-6 flex items-center justify-center">
              {level > 0 && <CornerDownRight className="w-4 h-4 text-muted-foreground/50" />}
            </div>
          )}

          <div className={`p-2 rounded-lg ${level === 0 ? 'bg-primary/10 text-primary' : 'bg-info/10 text-info'}`}>
            <Bot className="w-4 h-4" />
          </div>

          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-sm text-foreground truncate">
              {level === 0 ? '主代理' : '子代理'}: {session.agentType}
            </span>
            <span className="text-xs text-muted-foreground font-mono truncate">
              {session.model}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <StatusBadge status={session.status} />
          {session.error && (
            <div title="代理执行出错">
              <AlertTriangle className="w-4 h-4 text-danger animate-pulse" />
            </div>
          )}
        </div>
      </div>

      {/* Children */}
      {isExpanded && session.invocations && (
        <div className="flex flex-col w-full">
          {session.invocations.map((inv) => {
            if (inv.childSession) {
              return (
                <AgentTreeNode 
                  key={inv.childSession.id} 
                  session={inv.childSession} 
                  level={level + 1} 
                  onSelectSession={onSelectSession}
                  selectedSessionId={selectedSessionId}
                />
              );
            } else if (inv.status === 'failed') {
              // Failed subagent invocation without child session
              return (
                <div 
                  key={inv.id}
                  className="flex items-center justify-between p-3 rounded-xl border border-danger/30 bg-danger/5 mb-2"
                  style={{ marginLeft: `${(level + 1) * 24}px` }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-6 h-6 flex items-center justify-center">
                      <CornerDownRight className="w-4 h-4 text-danger/50" />
                    </div>
                    <div className="p-2 rounded-lg bg-danger/10 text-danger">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-semibold text-sm text-danger truncate">
                        子代理启动失败: {inv.agentType}
                      </span>
                      <span className="text-xs text-danger/80 font-mono truncate">
                        {inv.model}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <StatusBadge status="failed" />
                  </div>
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Session Detail Panel Component
// ---------------------------------------------------------------------------

interface DetailPanelProps {
  session: AgentSessionTree;
}

function AgentDetailPanel({ session }: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState<'messages' | 'tools' | 'raw'>('messages');

  return (
    <Card className="border-border/60 bg-muted/10 h-full flex flex-col">
      <CardHeader className="border-b border-border/50 pb-4 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-lg font-bold text-foreground flex items-center gap-2">
              <Cpu className="w-5 h-5 text-primary" />
              {session.parentSessionId ? '子代理详情' : '主代理详情'}
            </CardTitle>
            <CardDescription className="font-mono text-xs text-muted-foreground break-all">
              ID: {session.id}
            </CardDescription>
          </div>
          <StatusBadge status={session.status} />
        </div>

        <div className="grid grid-cols-2 gap-4 pt-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">代理类型</span>
            <span className="font-semibold text-foreground">{session.agentType}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">运行模型</span>
            <span className="font-mono font-semibold text-foreground">{session.model}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">启动时间</span>
            <span className="text-foreground">{formatDateTime(session.startedAt)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">结束时间</span>
            <span className="text-foreground">{formatDateTime(session.completedAt)}</span>
          </div>
        </div>

        {session.error && (
          <div className="mt-4 p-3 rounded-lg border border-danger/30 bg-danger/5 text-danger text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold">执行错误</div>
              <pre className="mt-1 font-mono text-xs whitespace-pre-wrap break-all">
                {typeof session.error === 'object' ? JSON.stringify(session.error, null, 2) : String(session.error)}
              </pre>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-0 flex flex-col">
        <div className="border-b border-border/50 px-4 py-2 bg-muted/30 shrink-0">
          <div className="flex gap-2">
            <Button 
              variant={activeTab === 'messages' ? 'default' : 'ghost'} 
              size="sm"
              onClick={() => setActiveTab('messages')}
              className="text-xs h-8"
            >
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              消息记录 ({session.messages?.length ?? 0})
            </Button>
            <Button 
              variant={activeTab === 'tools' ? 'default' : 'ghost'} 
              size="sm"
              onClick={() => setActiveTab('tools')}
              className="text-xs h-8"
            >
              <Terminal className="w-3.5 h-3.5 mr-1.5" />
              工具调用 ({session.toolCalls?.length ?? 0})
            </Button>
            <Button 
              variant={activeTab === 'raw' ? 'default' : 'ghost'} 
              size="sm"
              onClick={() => setActiveTab('raw')}
              className="text-xs h-8"
            >
              <Info className="w-3.5 h-3.5 mr-1.5" />
              元数据
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {activeTab === 'messages' && (
            <div className="space-y-4">
              {session.messages && session.messages.length > 0 ? (
                session.messages.map((msg) => (
                  <div 
                    key={msg.id} 
                    className={`flex flex-col p-3 rounded-xl border ${
                      msg.role === 'user' 
                        ? 'border-primary/20 bg-primary/5 ml-8' 
                        : msg.role === 'assistant' 
                        ? 'border-border bg-muted/40 mr-8' 
                        : 'border-warning/20 bg-warning/5 mx-4'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className={`text-xs font-bold uppercase tracking-wider ${
                        msg.role === 'user' ? 'text-primary' : msg.role === 'assistant' ? 'text-foreground' : 'text-warning'
                      }`}>
                        {msg.role}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatDateTime(msg.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm text-foreground whitespace-pre-wrap break-all font-sans leading-relaxed">
                      {typeof msg.content === 'string' 
                        ? msg.content 
                        : typeof msg.content === 'object' && msg.content !== null && 'text' in msg.content
                        ? String(msg.content.text)
                        : JSON.stringify(msg.content, null, 2)}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  暂无消息记录
                </div>
              )}
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="space-y-4">
              {session.toolCalls && session.toolCalls.length > 0 ? (
                session.toolCalls.map((tool) => (
                  <div key={tool.id} className="border border-border/60 rounded-xl overflow-hidden bg-muted/20">
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border/50">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5 text-primary" />
                        <span className="font-mono text-sm font-bold text-foreground">{tool.toolName}</span>
                      </div>
                      <StatusBadge status={tool.status} />
                    </div>
                    <div className="p-3 space-y-3 text-xs font-mono">
                      <div>
                        <div className="text-muted-foreground mb-1">参数 (Arguments)</div>
                        <pre className="p-2 rounded-lg bg-muted/80 border border-border/40 overflow-x-auto whitespace-pre-wrap break-all">
                          {JSON.stringify(tool.arguments, null, 2)}
                        </pre>
                      </div>
                      {tool.result !== undefined && (
                        <div>
                          <div className="text-muted-foreground mb-1">结果 (Result)</div>
                          <pre className="p-2 rounded-lg bg-muted/80 border border-border/40 overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                            {typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
                          </pre>
                        </div>
                      )}
                      {tool.error && (
                        <div>
                          <div className="text-danger mb-1">错误 (Error)</div>
                          <pre className="p-2 rounded-lg bg-danger/5 border border-danger/20 text-danger overflow-x-auto whitespace-pre-wrap break-all">
                            {typeof tool.error === 'string' ? tool.error : JSON.stringify(tool.error, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  暂无工具调用记录
                </div>
              )}
            </div>
          )}

          {activeTab === 'raw' && (
            <div className="space-y-4 font-mono text-xs">
              <div>
                <div className="text-muted-foreground mb-1">元数据 (Metadata)</div>
                <pre className="p-3 rounded-xl bg-muted/50 border border-border/50 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(session.metadata, null, 2)}
                </pre>
              </div>
              {session.finalResult !== undefined && (
                <div>
                  <div className="text-muted-foreground mb-1">最终结果 (Final Result)</div>
                  <pre className="p-3 rounded-xl bg-muted/50 border border-border/50 overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(session.finalResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function ReviewSessionsPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<AgentSessionTree | null>(null);

  // Fetch runs list
  const { data: runsData, isLoading: isListLoading, isError: isListError, error: listError } = useQuery({
    queryKey: ['reviewRuns'],
    queryFn: () => fetchReviewRuns(50),
  });

  // Fetch selected run details
  const { data: runDetails, isLoading: isDetailsLoading, isError: isDetailsError, error: detailsError } = useQuery({
    queryKey: ['reviewRunDetails', selectedRunId],
    queryFn: () => fetchReviewRunDetails(selectedRunId!),
    enabled: !!selectedRunId,
  });

  const runs = runsData?.data ?? [];

  // Handle run selection
  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    setSelectedSession(null); // Reset selected session when switching runs
  };

  // Automatically select first run if none selected
  if (!selectedRunId && runs.length > 0) {
    setSelectedRunId(runs[0].id);
  }

  // Automatically select root session when run details load
  if (runDetails?.sessionTree && !selectedSession) {
    setSelectedSession(runDetails.sessionTree);
  }

  return (
    <div className="theme-page-frame h-[calc(100vh-4rem)] flex flex-col overflow-hidden">
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Runs List */}
        <aside className="w-80 border-r border-border/50 flex flex-col bg-muted/10 shrink-0 overflow-hidden">
          <div className="p-4 border-b border-border/50 shrink-0">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              审查任务列表
            </h2>
            <p className="text-xs text-muted-foreground mt-1">展示最近 50 次自动审查任务</p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {isListLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="p-4 rounded-xl border border-border/40 space-y-2">
                  <Skeleton className="h-4 w-3/4 bg-muted/60" />
                  <Skeleton className="h-3 w-1/2 bg-muted/60" />
                </div>
              ))
            ) : isListError ? (
              <div className="theme-error-panel flex items-center gap-2 p-4">
                <AlertCircle className="w-5 h-5 text-danger" />
                <span className="text-sm font-medium">加载列表失败: {listError.message}</span>
              </div>
            ) : runs.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                暂无审查任务记录
              </div>
            ) : (
              runs.map((run) => {
                const isSelected = selectedRunId === run.id;
                return (
                  <div
                    key={run.id}
                    onClick={() => handleSelectRun(run.id)}
                    className={`p-3.5 rounded-xl border transition-all duration-200 cursor-pointer flex flex-col gap-2 ${
                      isSelected
                        ? 'border-primary/50 bg-primary/5 theme-glow-primary'
                        : 'border-transparent hover:bg-accent/40 hover:border-border/60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-bold text-sm text-foreground truncate flex-1">
                        {run.owner}/{run.repo}
                      </span>
                      <StatusBadge status={run.status} />
                    </div>

                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-border/60">
                        {run.eventType === 'pull_request' ? `PR #${run.prNumber}` : 'Commit'}
                      </Badge>
                      <span className="truncate font-mono text-[10px]">
                        {run.commitSha?.substring(0, 7) || run.headSha?.substring(0, 7) || '-'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/30">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(run.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                      <span>尝试: {run.attempts}/{run.maxAttempts}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Content: Run Details */}
        <main className="flex-1 flex flex-col overflow-hidden bg-background">
          {selectedRunId ? (
            isDetailsLoading ? (
              <div className="flex-1 p-6 space-y-6 overflow-y-auto">
                <div className="space-y-2">
                  <Skeleton className="h-8 w-1/3 bg-muted/60" />
                  <Skeleton className="h-4 w-1/4 bg-muted/60" />
                </div>
                <Skeleton className="h-[400px] w-full rounded-xl bg-muted/60 border border-border/60" />
              </div>
            ) : isDetailsError ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="theme-error-panel flex items-center gap-3 max-w-md">
                  <AlertCircle className="w-6 h-6 text-danger shrink-0" />
                  <div>
                    <div className="font-bold text-foreground">加载详情失败</div>
                    <div className="text-sm text-muted-foreground mt-1">{detailsError.message}</div>
                  </div>
                </div>
              </div>
            ) : !runDetails ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                未找到任务详情
              </div>
            ) : (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Detail Header */}
                <header className="p-6 border-b border-border/50 shrink-0 bg-muted/5">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <h1 className="text-xl font-bold text-foreground tracking-tight">
                          {runDetails.run.owner}/{runDetails.run.repo}
                        </h1>
                        <StatusBadge status={runDetails.run.status} />
                        <Badge variant="outline" className="border-border/60">
                          {runDetails.run.eventType === 'pull_request' ? `PR #${runDetails.run.prNumber}` : 'Commit'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono break-all">
                        任务 ID: {runDetails.run.id} | Commit: {runDetails.run.commitSha || runDetails.run.headSha || '-'}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
                      <div className="flex flex-col items-end">
                        <span className="text-xs text-muted-foreground">创建时间</span>
                        <span className="font-medium text-foreground">{formatDateTime(runDetails.run.createdAt)}</span>
                      </div>
                      {runDetails.run.finishedAt && (
                        <div className="flex flex-col items-end">
                          <span className="text-xs text-muted-foreground">完成时间</span>
                          <span className="font-medium text-foreground">{formatDateTime(runDetails.run.finishedAt)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {runDetails.run.error && (
                    <div className="mt-4 p-3 rounded-xl border border-danger/30 bg-danger/5 text-danger text-sm flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">任务执行失败:</span> {runDetails.run.error}
                      </div>
                    </div>
                  )}
                </header>

                {/* Detail Tabs */}
                <Tabs defaultValue="observability" className="flex-1 flex flex-col overflow-hidden">
                  <div className="px-6 border-b border-border/50 bg-muted/5 shrink-0">
                    <TabsList className="h-12 bg-transparent p-0 gap-6 border-b-0">
                      <TabsTrigger 
                        value="observability" 
                        className="h-12 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-1 font-semibold text-sm"
                      >
                        代理观测 (Observability)
                      </TabsTrigger>
                      <TabsTrigger 
                        value="findings" 
                        className="h-12 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-1 font-semibold text-sm"
                      >
                        审查结果 ({runDetails.findings?.length ?? 0})
                      </TabsTrigger>
                      <TabsTrigger 
                        value="log" 
                        className="h-12 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-1 font-semibold text-sm"
                      >
                        运行日志 ({runDetails.steps?.length ?? 0})
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  {/* Tab Content: Observability */}
                  <TabsContent value="observability" className="flex-1 overflow-hidden p-6 m-0 flex flex-col md:flex-row gap-6">
                    {runDetails.sessionTree ? (
                      <>
                        {/* Left: Session Tree */}
                        <div className="flex-1 flex flex-col overflow-y-auto pr-2">
                          <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
                            <Layers className="w-4 h-4" />
                            代理调用树 (Parent-Child Tree)
                          </h3>
                          <div className="space-y-2">
                            <AgentTreeNode 
                              session={runDetails.sessionTree} 
                              level={0} 
                              onSelectSession={(session) => setSelectedSession(session)}
                              selectedSessionId={selectedSession?.id}
                            />
                          </div>
                        </div>

                        {/* Right: Selected Session Detail */}
                        <div className="flex-1 h-full overflow-hidden">
                          {selectedSession ? (
                            <AgentDetailPanel session={selectedSession} />
                          ) : (
                            <div className="h-full border border-dashed border-border/60 rounded-xl flex flex-col items-center justify-center text-muted-foreground p-6">
                              <Bot className="w-12 h-12 text-muted-foreground/40 mb-3 animate-pulse" />
                              <p className="text-sm font-medium">请在左侧选择一个代理节点查看详细调用轨迹</p>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border border-dashed border-border/60 rounded-xl p-12">
                        <HelpCircle className="w-12 h-12 text-muted-foreground/40 mb-3" />
                        <p className="text-sm font-medium">本次审查任务未使用 Agent 引擎，或暂无代理调用轨迹数据</p>
                        <p className="text-xs text-muted-foreground/80 mt-1">请确保系统配置中已启用 Agent 审查引擎</p>
                      </div>
                    )}
                  </TabsContent>

                  {/* Tab Content: Findings */}
                  <TabsContent value="findings" className="flex-1 overflow-y-auto p-6 m-0 space-y-4">
                    {runDetails.findings && runDetails.findings.length > 0 ? (
                      runDetails.findings.map((finding) => (
                        <Card key={finding.id} className="border-border/60 hover:border-border transition-all duration-200">
                          <CardHeader className="pb-3">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <SeverityBadge severity={finding.severity} />
                                  <Badge variant="outline" className="bg-muted/50 border-border/60 text-xs">
                                    {finding.category}
                                  </Badge>
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {finding.path}:{finding.line}
                                  </span>
                                </div>
                                <CardTitle className="text-base font-bold text-foreground tracking-tight">
                                  {finding.title}
                                </CardTitle>
                              </div>
                              <div className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                                <Info className="w-3.5 h-3.5" />
                                置信度: {(finding.confidence * 100).toFixed(0)}%
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent className="space-y-4 text-sm">
                            <div>
                              <div className="font-semibold text-foreground mb-1">详细描述</div>
                              <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{finding.detail}</p>
                            </div>
                            {finding.evidence && (
                              <div>
                                <div className="font-semibold text-foreground mb-1">代码证据</div>
                                <pre className="p-3 rounded-xl bg-muted/50 border border-border/50 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all">
                                  {finding.evidence}
                                </pre>
                              </div>
                            )}
                            {finding.suggestion && (
                              <div className="p-3.5 rounded-xl border border-success/20 bg-success/5">
                                <div className="font-semibold text-success flex items-center gap-1.5 mb-1">
                                  <CheckCircle2 className="w-4 h-4" />
                                  修改建议
                                </div>
                                <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{finding.suggestion}</p>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      ))
                    ) : (
                      <div className="text-center py-12 text-muted-foreground text-sm border border-dashed border-border/60 rounded-xl">
                        本次审查未发现任何问题
                      </div>
                    )}
                  </TabsContent>

                  {/* Tab Content: Run Log */}
                  <TabsContent value="log" className="flex-1 overflow-y-auto p-6 m-0 space-y-6">
                    {/* Steps */}
                    <div className="space-y-4">
                      <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                        <Layers className="w-4 h-4" />
                        执行步骤 (Steps)
                      </h3>
                      <div className="border border-border/60 rounded-xl overflow-hidden bg-muted/10">
                        <table className="w-full text-left border-collapse text-sm">
                          <thead>
                            <tr className="bg-muted/50 border-b border-border/50 text-muted-foreground font-semibold">
                              <th className="p-3">步骤名称</th>
                              <th className="p-3">状态</th>
                              <th className="p-3">耗时</th>
                              <th className="p-3">开始时间</th>
                              <th className="p-3">结束时间</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/40">
                            {runDetails.steps && runDetails.steps.length > 0 ? (
                              runDetails.steps.map((step) => (
                                <tr key={step.id} className="hover:bg-accent/20 transition-colors">
                                  <td className="p-3 font-medium text-foreground">{step.stepName}</td>
                                  <td className="p-3">
                                    <StatusBadge status={step.status} />
                                  </td>
                                  <td className="p-3 font-mono text-xs">
                                    {step.latencyMs ? `${(step.latencyMs / 1000).toFixed(2)}s` : '-'}
                                  </td>
                                  <td className="p-3 text-xs text-muted-foreground">{formatDateTime(step.startedAt)}</td>
                                  <td className="p-3 text-xs text-muted-foreground">{formatDateTime(step.finishedAt)}</td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td colSpan={5} className="p-8 text-center text-muted-foreground">
                                  暂无步骤记录
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Comments */}
                    <div className="space-y-4">
                      <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        评论记录 (Comments)
                      </h3>
                      <div className="space-y-3">
                        {runDetails.comments && runDetails.comments.length > 0 ? (
                          runDetails.comments.map((comment) => (
                            <div key={comment.id} className="p-4 rounded-xl border border-border/60 bg-muted/20 space-y-2">
                              <div className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-2">
                                  {comment.path && (
                                    <span className="font-mono text-muted-foreground">
                                      {comment.path}:{comment.line}
                                    </span>
                                  )}
                                  {comment.giteaCommentId && (
                                    <Badge variant="outline" className="text-[10px] border-border/60">
                                      Gitea ID: {comment.giteaCommentId}
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <StatusBadge status={comment.status} />
                                  <span className="text-muted-foreground">{formatDateTime(comment.createdAt)}</span>
                                </div>
                              </div>
                              <p className="text-sm text-foreground whitespace-pre-wrap break-all leading-relaxed">
                                {comment.body}
                              </p>
                            </div>
                          ))
                        ) : (
                          <div className="text-center py-8 text-muted-foreground text-sm border border-dashed border-border/60 rounded-xl">
                            暂无评论记录
                          </div>
                        )}
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            )
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-6">
              <Bot className="w-16 h-16 text-muted-foreground/30 mb-4 animate-pulse" />
              <h3 className="text-lg font-bold text-foreground">请选择一个审查任务</h3>
              <p className="text-sm text-muted-foreground mt-1">在左侧列表中选择一个任务以查看其详细的代理调用轨迹和审查结果</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
