import { Button } from '@/components/ui/button';
import { LogOut, Bot, Settings } from 'lucide-react';
import { RepositoryManager } from '@/components/RepositoryManager';

export default function DashboardPage() {
  const handleLogout = () => {
    localStorage.removeItem('authToken');
    window.location.reload();
  };

  return (
    <div className="grid min-h-screen w-full lg:grid-cols-[280px_1fr]">
      <div className="hidden border-r bg-gray-100/40 lg:block dark:bg-gray-800/40">
        <div className="flex h-full max-h-screen flex-col gap-2">
          <div className="flex h-[60px] items-center border-b px-6">
            <a href="/" className="flex items-center gap-2 font-semibold">
              <Bot className="h-6 w-6" />
              <span>Gitea AI Assistant</span>
            </a>
          </div>
          <div className="flex-1 overflow-auto py-2">
            <nav className="grid items-start px-4 text-sm font-medium">
              <a
                href="#"
                className="flex items-center gap-3 rounded-lg bg-gray-100 px-3 py-2 text-gray-900 transition-all hover:text-gray-900 dark:bg-gray-800 dark:text-gray-50 dark:hover:text-gray-50"
              >
                <Settings className="h-4 w-4" />
                Webhook 管理
              </a>
            </nav>
          </div>
        </div>
      </div>
      <div className="flex flex-col">
        <header className="flex h-14 lg:h-[60px] items-center gap-4 border-b bg-gray-100/40 px-6 dark:bg-gray-800/40">
          <div className="w-full flex-1">
            {/* Can add search bar here in the future */}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full border w-8 h-8"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
            <span className="sr-only">Toggle user menu</span>
          </Button>
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-6">
          <RepositoryManager />
        </main>
      </div>
    </div>
  );
}
