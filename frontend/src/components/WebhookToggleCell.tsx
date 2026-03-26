"use client"

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import api from '@/lib/api';
import type { Repository } from '@/services/repositoryService';

interface WebhookToggleCellProps {
  repo: Repository;
}

const createWebhook = (repoName: string) =>
  api.post(`/repositories/${repoName}/webhook`);
const deleteWebhook = ({ repoName, hookId }: { repoName: string; hookId: number }) =>
  api.delete(`/repositories/${repoName}/webhook/${hookId}`);

export function WebhookToggleCell({ repo }: WebhookToggleCellProps) {
  const queryClient = useQueryClient();
  const isActive = repo.webhook_status === 'active';

  const webhookMutation = useMutation({
    mutationFn: async () => {
      if (isActive && repo.hook_id) {
        return deleteWebhook({ repoName: repo.name, hookId: repo.hook_id });
      }
      return createWebhook(repo.name);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
      const action = isActive ? '已禁用' : '已启用';
      toast.success(`${repo.name} 的 Webhook ${action}`);
    },
    onError: (error: Error) => {
      toast.error(`操作失败: ${error.message}`);
    },
  });

  return (
    <div className="flex items-center gap-2">
      {webhookMutation.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Switch
          checked={isActive}
          onCheckedChange={() => webhookMutation.mutate()}
          disabled={webhookMutation.isPending}
          aria-label={isActive ? '禁用 Webhook' : '启用 Webhook'}
        />
      )}
      <span className={`text-xs ${isActive ? 'text-success' : 'text-muted-foreground'}`}>
        {isActive ? '已启用' : '未启用'}
      </span>
    </div>
  );
}
