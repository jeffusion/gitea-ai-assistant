import { Button } from '@/components/ui/button';
import type { TestResult } from '@/services/llmProviderService';
import { CheckCircle2, XCircle } from 'lucide-react';

interface TestResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: TestResult | null;
  providerName: string;
}

export function TestResultDialog({ open, onOpenChange, result, providerName }: TestResultDialogProps) {
  if (!open || !result) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-surface-overlay backdrop-blur-sm">
      <div className="theme-dialog-panel">
        <div className="theme-dialog-header">
          <h2 className="text-xl font-bold text-foreground">测试结果 - {providerName}</h2>
        </div>
        
        <div className="theme-dialog-body space-y-5">
          {result.success ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-success">
                <CheckCircle2 className="w-8 h-8" />
                <span className="text-lg font-medium">连接成功</span>
              </div>
              
              <div className="space-y-2 text-sm text-foreground/90">
                {result.latencyMs !== undefined && (
                  <div className="flex justify-between border-b border-border/60 pb-2">
                    <span className="text-muted-foreground">延迟:</span>
                    <span>{result.latencyMs} ms</span>
                  </div>
                )}
                
                {result.model && (
                  <div className="flex justify-between border-b border-border/60 pb-2">
                    <span className="text-muted-foreground">模型:</span>
                    <span className="font-mono">{result.model}</span>
                  </div>
                )}
                
                {result.message && (
                  <div className="space-y-2 pt-2">
                    <span className="text-muted-foreground">AI 响应:</span>
                    <div className="bg-muted/60 border border-border rounded-md p-3 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                      {result.message}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-danger">
                <XCircle className="w-8 h-8" />
                <span className="text-lg font-medium">测试失败</span>
              </div>
              
              <div className="space-y-2 text-sm text-foreground/90">
                {result.latencyMs !== undefined && (
                  <div className="flex justify-between border-b border-border/60 pb-2">
                    <span className="text-muted-foreground">延迟:</span>
                    <span>{result.latencyMs} ms</span>
                  </div>
                )}
                
                <div className="space-y-2 pt-2">
                  <span className="text-muted-foreground">错误:</span>
                  <div className="bg-danger/10 border border-danger/20 text-danger rounded-md p-3 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                    {result.error || result.message || '未知错误'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="theme-dialog-footer flex justify-end">
          <Button type="button" onClick={() => onOpenChange(false)} className="bg-primary text-primary-foreground hover:bg-primary/90">
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
