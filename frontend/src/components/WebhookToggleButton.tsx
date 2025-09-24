import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { toast } from "sonner";

interface WebhookToggleButtonProps {
  repoName: string;
  status: 'active' | 'inactive';
  hookId: number | null;
}

const createWebhook = (repoName: string) => api.post(`/repositories/${repoName}/webhook`);
const deleteWebhook = ({ repoName, hookId }: { repoName: string; hookId: number }) => api.delete(`/repositories/${repoName}/webhook/${hookId}`);

export function WebhookToggleButton({ repoName, status, hookId }: WebhookToggleButtonProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: status === 'active'
      ? () => deleteWebhook({ repoName, hookId: hookId! })
      : () => createWebhook(repoName),
    onSuccess: () => {
      // 操作成功后，使仓库列表的查询失效，React Query会自动重新获取最新数据
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
      toast.success(`Webhook for ${repoName} has been ${status === 'active' ? 'disabled' : 'enabled'}.`);
    },
    onError: (error) => {
      console.error("操作失败:", error);
      toast.error(`Operation failed: ${error.message}`);
    },
  });

  return (
    <Button
      variant={status === 'active' ? 'destructive' : 'default'}
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
    >
      {mutation.isPending
        ? '处理中...'
        : status === 'active' ? '停用' : '启用'}
    </Button>
  );
}
