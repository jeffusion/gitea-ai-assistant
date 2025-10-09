import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Settings, Database, LogOut } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();

  const handleLogout = () => {
    localStorage.removeItem('admin_token');
    window.location.reload();
  };

  const navigation = [
    {
      name: '仓库管理',
      href: '/dashboard',
      icon: Database,
      current: location.pathname === '/dashboard'
    },
    {
      name: '系统配置',
      href: '/config',
      icon: Settings,
      current: location.pathname === '/config'
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* 顶部导航栏 */}
      <header className="border-b">
        <div className="flex h-16 items-center px-6">
          <div className="flex items-center space-x-4">
            <h1 className="text-xl font-semibold">Gitea AI Assistant</h1>
            <Badge variant="secondary">管理后台</Badge>
          </div>

          <nav className="flex items-center space-x-1 ml-8">
            {navigation.map((item) => (
              <Link key={item.name} to={item.href}>
                <Button
                  variant={item.current ? 'default' : 'ghost'}
                  size="sm"
                  className={cn(
                    'flex items-center space-x-2',
                    item.current ? 'bg-primary text-primary-foreground' : ''
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.name}</span>
                </Button>
              </Link>
            ))}
          </nav>

          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="flex items-center space-x-2"
            >
              <LogOut className="h-4 w-4" />
              <span>退出登录</span>
            </Button>
          </div>
        </div>
      </header>

      {/* 主内容区域 */}
      <main className="flex-1">
        {children}
      </main>
    </div>
  );
}