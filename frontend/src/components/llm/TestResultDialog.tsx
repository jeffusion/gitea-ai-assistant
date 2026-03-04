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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-panel w-full max-w-md bg-zinc-950 border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-white/10">
          <h2 className="text-xl font-bold text-zinc-100">测试结果 - {providerName}</h2>
        </div>
        
        <div className="p-6 flex-1 overflow-y-auto space-y-5">
          {result.success ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-green-500">
                <CheckCircle2 className="w-8 h-8" />
                <span className="text-lg font-medium">连接成功</span>
              </div>
              
              <div className="space-y-2 text-sm text-zinc-300">
                {result.latencyMs !== undefined && (
                  <div className="flex justify-between border-b border-white/5 pb-2">
                    <span className="text-zinc-500">延迟:</span>
                    <span>{result.latencyMs} ms</span>
                  </div>
                )}
                
                {result.model && (
                  <div className="flex justify-between border-b border-white/5 pb-2">
                    <span className="text-zinc-500">模型:</span>
                    <span className="font-mono">{result.model}</span>
                  </div>
                )}
                
                {result.message && (
                  <div className="space-y-2 pt-2">
                    <span className="text-zinc-500">AI 响应:</span>
                    <div className="bg-zinc-900 border border-white/10 rounded-md p-3 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                      {result.message}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-red-500">
                <XCircle className="w-8 h-8" />
                <span className="text-lg font-medium">测试失败</span>
              </div>
              
              <div className="space-y-2 text-sm text-zinc-300">
                {result.latencyMs !== undefined && (
                  <div className="flex justify-between border-b border-white/5 pb-2">
                    <span className="text-zinc-500">延迟:</span>
                    <span>{result.latencyMs} ms</span>
                  </div>
                )}
                
                <div className="space-y-2 pt-2">
                  <span className="text-zinc-500">错误:</span>
                  <div className="bg-zinc-900/50 border border-red-500/20 text-red-400 rounded-md p-3 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                    {result.error || result.message || '未知错误'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-white/10 flex justify-end bg-zinc-900/50">
          <Button type="button" onClick={() => onOpenChange(false)} className="bg-primary text-primary-foreground hover:bg-primary/90">
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
