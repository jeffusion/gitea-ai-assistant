"use client"

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Settings, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import api from '@/lib/api';
import type { Repository } from '@/services/repositoryService';

interface RepositoryConfigCellProps {
  repo: Repository;
}

export function RepositoryConfigCell({ repo }: RepositoryConfigCellProps) {
  const queryClient = useQueryClient();
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(repo.project_review_prompt ?? '');

  const promptMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const { data } = await api.put(`/repositories/${repo.name}/project-prompt`, {
        project_review_prompt: prompt,
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
      setIsPromptDialogOpen(false);
      toast.success(`已更新 ${repo.name} 的项目级提示词`);
    },
    onError: (error: Error) => {
      toast.error(`更新失败: ${error.message}`);
    },
  });

  const handleSavePrompt = () => {
    promptMutation.mutate(draftPrompt.trim());
  };

  const handleOpenDialog = () => {
    setDraftPrompt(repo.project_review_prompt ?? '');
    setIsPromptDialogOpen(true);
  };

  const hasPrompt = !!repo.project_review_prompt?.trim();

  return (
    <>
      <Button
        variant={hasPrompt ? "outline" : "ghost"}
        size="sm"
        className={`h-8 gap-1.5 text-xs ${
          hasPrompt 
            ? "border-primary/50 text-primary hover:bg-primary/10" 
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={handleOpenDialog}
      >
        <Settings className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{hasPrompt ? '已配置' : '配置'}</span>
        {hasPrompt && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" />}
      </Button>

      <Dialog open={isPromptDialogOpen} onOpenChange={setIsPromptDialogOpen}>
        <DialogContent className="sm:max-w-[525px]">
          <DialogHeader>
            <DialogTitle>配置项目级提示词</DialogTitle>
            <DialogDescription>
              为仓库 <code className="rounded bg-muted px-1 py-0.5 text-xs">{repo.name}</code> 设置审查提示词
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {hasPrompt && (
              <div className="rounded-lg bg-muted/50 border border-border/50 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">当前配置</span>
                </div>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-all max-h-[80px] overflow-y-auto">
                  {repo.project_review_prompt}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">提示词内容</label>
              <Textarea
                value={draftPrompt}
                onChange={(e) => setDraftPrompt(e.target.value)}
                placeholder="输入项目级审查提示词，例如：重点关注 API 安全性、空值处理和错误边界..."
                className="min-h-[120px] resize-none text-sm leading-relaxed focus-visible:ring-1 focus-visible:ring-primary/50"
                disabled={promptMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                此提示词将在代码审查时与全局提示词合并，传递给 AI 模型。
                {hasPrompt && ' 留空保存将清除当前配置。'}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsPromptDialogOpen(false)}
              disabled={promptMutation.isPending}
            >
              取消
            </Button>
            <Button
              onClick={handleSavePrompt}
              disabled={
                promptMutation.isPending ||
                draftPrompt.trim() === (repo.project_review_prompt ?? '').trim()
              }
            >
              {promptMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  保存中
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
