import { RepositoryManager } from '@/components/RepositoryManager';

export default function DashboardPage() {
  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">仓库管理</h1>
        <p className="text-muted-foreground">
          管理Gitea仓库的AI代码审查Webhook
        </p>
      </div>
      <RepositoryManager />
    </div>
  );
}