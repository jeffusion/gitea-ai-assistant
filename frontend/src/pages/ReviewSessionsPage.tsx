import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock3, ListTodo, RefreshCw, Waypoints } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  fetchReviewSessionDetail,
  fetchReviewSessions,
  type ReviewPlanStepDto,
  type ReviewSessionSummaryRecordDto,
  type ReviewTimelineEntryDto,
} from '@/services/reviewSessionService';

const statusLabelMap: Record<ReviewSessionSummaryRecordDto['summary']['status'], string> = {
  queued: '排队中',
  planning: '制定计划',
  executing: '执行中',
  awaiting_human_feedback: '等待人工反馈',
  completed: '已完成',
  failed: '失败',
  ignored: '已忽略',
};

const statusClassMap: Record<ReviewSessionSummaryRecordDto['summary']['status'], string> = {
  queued: 'border-border bg-muted/60 text-muted-foreground',
  planning: 'border-info/30 bg-info/10 text-info',
  executing: 'border-primary/30 bg-primary/10 text-primary',
  awaiting_human_feedback: 'border-warning/30 bg-warning/15 text-warning-foreground',
  completed: 'border-success/30 bg-success/15 text-success',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  ignored: 'border-border bg-muted/50 text-muted-foreground',
};

const planStatusClassMap: Record<ReviewPlanStepDto['status'], string> = {
  pending: 'border-border bg-muted/40 text-muted-foreground',
  queued: 'border-info/20 bg-info/10 text-info',
  running: 'border-primary/20 bg-primary/10 text-primary',
  completed: 'border-success/20 bg-success/10 text-success',
  failed: 'border-destructive/20 bg-destructive/10 text-destructive',
  skipped: 'border-border bg-muted/40 text-muted-foreground',
};

const timelineToneClassMap: Record<ReviewTimelineEntryDto['tone'], string> = {
  neutral: 'border-border bg-card/80',
  success: 'border-success/20 bg-success/5',
  warning: 'border-warning/20 bg-warning/5',
  danger: 'border-destructive/20 bg-destructive/5',
};

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateSha(value?: string): string {
  if (!value) return '—';
  return value.slice(0, 8);
}

function SessionMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: typeof Clock3;
}) {
  return (
    <Card className="gap-0 border-border/70 bg-card/70 backdrop-blur-sm">
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ReviewSessionsPage() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ['review-sessions'],
    queryFn: fetchReviewSessions,
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (!selectedSessionId && sessionsQuery.data?.length) {
      setSelectedSessionId(sessionsQuery.data[0].session.id);
    }
  }, [selectedSessionId, sessionsQuery.data]);

  const detailQuery = useQuery({
    queryKey: ['review-session-detail', selectedSessionId],
    queryFn: () => fetchReviewSessionDetail(selectedSessionId as string),
    enabled: !!selectedSessionId,
    refetchInterval: 15000,
  });

  const metrics = useMemo(() => {
    const sessions = sessionsQuery.data ?? [];
    return {
      total: sessions.length,
      active: sessions.filter(({ summary }) => summary.status === 'planning' || summary.status === 'executing').length,
      waiting: sessions.filter(({ summary }) => summary.status === 'awaiting_human_feedback').length,
      findings: sessions.reduce((total, item) => total + item.summary.findingCount, 0),
    };
  }, [sessionsQuery.data]);

  return (
    <div className="theme-page-frame">
      <div className="theme-page-content space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SessionMetric label="PR 会话" value={metrics.total} icon={Waypoints} />
          <SessionMetric label="执行中" value={metrics.active} icon={RefreshCw} />
          <SessionMetric label="待人工确认" value={metrics.waiting} icon={AlertTriangle} />
          <SessionMetric label="累计 Findings" value={metrics.findings} icon={ListTodo} />
        </div>

        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="border-border/70 bg-card/80 backdrop-blur-sm">
            <CardHeader className="border-b border-border/60 pb-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-xl">审查会话</CardTitle>
                  <CardDescription>每个 PR head 对应一个 session，支持计划与继续执行。</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => sessionsQuery.refetch()}
                  className="border-border/70"
                >
                  刷新
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              {sessionsQuery.isLoading && (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-24 rounded-2xl" />
                  ))}
                </div>
              )}

              {!sessionsQuery.isLoading && sessionsQuery.data?.length === 0 && (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
                  还没有审查会话。收到新的 PR webhook 后，这里会出现 session 与执行计划。
                </div>
              )}

              {sessionsQuery.data?.map(({ session, summary }) => {
                const selected = selectedSessionId === session.id;
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`w-full rounded-2xl border p-4 text-left transition-all ${
                      selected
                        ? 'border-primary/40 bg-primary/10 shadow-sm'
                        : 'border-border/70 bg-card/60 hover:border-primary/20 hover:bg-accent/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold tracking-tight text-foreground">
                          {summary.owner}/{summary.repo}
                          {summary.prNumber ? ` #${summary.prNumber}` : ''}
                        </div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">{summary.scopeKey}</div>
                      </div>
                      <Badge className={statusClassMap[summary.status]}>{statusLabelMap[summary.status]}</Badge>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-muted-foreground">当前步骤</div>
                        <div className="mt-1 font-medium text-foreground">{summary.currentStep ?? '等待计划'}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Head SHA</div>
                        <div className="mt-1 font-mono text-foreground">{truncateSha(summary.headSha)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Findings</div>
                        <div className="mt-1 font-medium text-foreground">{summary.findingCount}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">更新时间</div>
                        <div className="mt-1 font-medium text-foreground">{formatDate(summary.updatedAt)}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/80 backdrop-blur-sm">
            <CardHeader className="border-b border-border/60 pb-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-xl">会话详情</CardTitle>
                  <CardDescription>审查结果、运行日志按 session 聚合。</CardDescription>
                </div>
                {detailQuery.data && (
                  <Badge className={statusClassMap[detailQuery.data.summary.status]}>
                    {statusLabelMap[detailQuery.data.summary.status]}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {detailQuery.isLoading && <Skeleton className="h-[640px] rounded-2xl" />}

              {!detailQuery.isLoading && !detailQuery.data && (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-8 text-sm text-muted-foreground">
                  选择一个 session 查看它的执行计划与时间线。
                </div>
              )}

              {detailQuery.data && (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-2xl border border-border/70 bg-muted/25 p-4">
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Session</div>
                      <div className="mt-2 font-mono text-sm text-foreground">{detailQuery.data.session.id.slice(0, 8)}</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-muted/25 p-4">
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Head SHA</div>
                      <div className="mt-2 font-mono text-sm text-foreground">{truncateSha(detailQuery.data.summary.headSha)}</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-muted/25 p-4">
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">当前步骤</div>
                      <div className="mt-2 text-sm font-medium text-foreground">{detailQuery.data.summary.currentStep ?? '无'}</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-muted/25 p-4">
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">待执行任务</div>
                      <div className="mt-2 text-sm font-medium text-foreground">{detailQuery.data.summary.pendingTaskCount}</div>
                    </div>
                  </div>

            <Tabs defaultValue="results" className="space-y-4">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="results">审查结果</TabsTrigger>
                <TabsTrigger value="logs">运行日志</TabsTrigger>
              </TabsList>

              <TabsContent value="results" className="space-y-4">
                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Findings</h4>
                  {detailQuery.data.runDetails?.findings.length ? (
                    detailQuery.data.runDetails.findings.map((finding) => (
                      <div key={finding.id} className="mb-3 rounded-2xl border border-border/70 bg-card/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-base">{finding.severity === 'high' ? '🔴' : finding.severity === 'medium' ? '🟡' : '🔵'}</span>
                              <span className="font-semibold text-foreground">{finding.title}</span>
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">{finding.path}:{finding.line}</div>
                          </div>
                          <div className="flex gap-2">
                            <Badge variant="outline">{finding.category}</Badge>
                            <Badge className={finding.published ? 'bg-success/15 text-success border-success/20' : 'bg-warning/15 text-warning-foreground border-warning/20'}>
                              {finding.published ? '已发布' : '待处理'}
                            </Badge>
                          </div>
                        </div>
                        {finding.detail && <div className="mt-3 text-sm text-muted-foreground">{finding.detail}</div>}
                        {finding.evidence && <div className="mt-2 rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-xs text-muted-foreground">{finding.evidence}</div>}
                        {finding.suggestion && <div className="mt-2 text-sm text-foreground">💡 {finding.suggestion}</div>}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
                      当前 session 暂无 findings。
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Gitea 评论</h4>
                  {detailQuery.data.runDetails?.comments.length ? (
                    detailQuery.data.runDetails.comments.map((comment) => (
                      <div key={comment.id} className="mb-3 rounded-2xl border border-border/70 bg-card/60 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <Badge variant="outline">{comment.status}</Badge>
                          <div className="font-mono text-xs text-muted-foreground">{formatDate(comment.createdAt)}</div>
                        </div>
                        {(comment.path || comment.line) && (
                          <div className="mt-2 text-xs font-mono text-muted-foreground">
                            {[comment.path, comment.line].filter(Boolean).join(':')}
                          </div>
                        )}
                        <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground">{comment.body}</pre>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
                      当前 session 暂无评论产物。
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="logs" className="space-y-4">
                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">执行步骤</h4>
                  <div className="flex flex-wrap gap-2">
                    {detailQuery.data.plan.map((step) => (
                      <div
                        key={step.key}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${planStatusClassMap[step.status]}`}
                      >
                        <span className="font-medium">{step.label}</span>
                        <Badge className={planStatusClassMap[step.status]}>{step.status}</Badge>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">事件流</h4>
                  {detailQuery.data.timeline.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
                      当前 session 还没有时间线事件。
                    </div>
                  )}
                  {detailQuery.data.timeline.map((entry) => (
                    <div
                      key={entry.id}
                      className={`mb-2 rounded-2xl border p-4 ${timelineToneClassMap[entry.tone]}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold text-foreground">{entry.title}</div>
                        <div className="font-mono text-xs text-muted-foreground">{formatDate(entry.timestamp)}</div>
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">{entry.detail}</div>
                    </div>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
