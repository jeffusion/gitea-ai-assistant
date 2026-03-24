import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { LogOut, Bot, FolderGit2, Sliders, Bell, Menu, X, PanelLeftClose, PanelLeftOpen, FileSearch, Sun, Moon, Palette } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { isColorPalette, useColorPalette } from '@/hooks/useColorPalette';

const navItems = [
  { path: '/repos', label: '仓库管理', icon: FolderGit2 },
  { path: '/config', label: '系统配置', icon: Sliders },
  { path: '/notifications', label: '通知管理', icon: Bell },
  { path: '/review-config', label: '审查配置', icon: FileSearch },
] as const;

export default function DashboardPage() {
  const location = useLocation();
  const { setTheme, resolvedTheme } = useTheme();
  const { palette, setPalette } = useColorPalette();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    window.location.href = '/';
  };

  const currentTitle = navItems.find(item => location.pathname.startsWith(item.path))?.label || 'Dashboard';
  const isConfigPage = location.pathname.startsWith('/config');
  const isNotificationPage = location.pathname.startsWith('/notifications');
  const isReviewConfigPage = location.pathname.startsWith('/review-config');

  return (
    <div className="theme-shell-gradient flex h-screen w-full overflow-hidden bg-background">
      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 z-40 theme-surface-overlay backdrop-blur-md lg:hidden animate-in fade-in"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside 
          className={`theme-sidebar-shell fixed inset-y-0 left-0 z-50 flex flex-col transition-all duration-300 ease-in-out ${
            isSidebarCollapsed ? 'w-[72px]' : 'w-64'
          } ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className="theme-sidebar-header flex h-16 items-center justify-between px-4">
          <div className={`flex items-center gap-3 overflow-hidden transition-all duration-300 ${isSidebarCollapsed ? 'w-10 justify-center -ml-1' : 'w-full'}`}>
            <div className="theme-interactive-elevate flex shrink-0 h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 theme-glow-primary ring-1 ring-primary/10">
              <Bot className="h-5 w-5" />
            </div>
            {!isSidebarCollapsed && (
              <span className="truncate font-bold tracking-tight text-foreground whitespace-nowrap">
                Gitea AI Assistant
              </span>
            )}
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="lg:hidden shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex-1 space-y-2 overflow-y-auto p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `group relative flex w-full items-center rounded-xl border p-2.5 transition-all duration-200 ${
                    isActive
                      ? 'border-primary/[0.14] bg-primary/[0.08] text-primary shadow-sm'
                      : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:border-border/60 hover:text-foreground'
                   } ${isSidebarCollapsed ? 'justify-center' : 'justify-start gap-3'}`
                 }
                title={isSidebarCollapsed ? item.label : undefined}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <div className="absolute left-0 top-1/2 h-1/2 w-1 -translate-y-1/2 rounded-r-full bg-primary theme-glow-primary"></div>
                    )}
                    <Icon className={`h-5 w-5 shrink-0 transition-transform duration-300 ${isActive ? 'text-primary scale-110' : 'text-muted-foreground group-hover:text-foreground'}`} />
                    {!isSidebarCollapsed && (
                      <span className="font-medium tracking-wide text-sm">{item.label}</span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="theme-sidebar-footer p-3">
          <button
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            className={`hidden lg:flex w-full items-center rounded-xl border border-transparent p-2.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:border-border/60 hover:text-foreground ${
              isSidebarCollapsed ? 'justify-center' : 'justify-start gap-3'
            }`}
          >
            {isSidebarCollapsed ? (
              <PanelLeftOpen className="h-5 w-5" />
            ) : (
              <>
                <PanelLeftClose className="h-5 w-5" />
                <span className="font-medium text-sm">收起侧边栏</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div
        className={`relative flex flex-1 flex-col overflow-hidden transition-[margin] duration-300 ease-in-out ${
          isSidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-64'
        }`}
      >
        {/* Top Header */}
        <header className="theme-sticky-bar flex h-16 shrink-0 items-center justify-between px-4 z-10">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              className="lg:hidden text-muted-foreground hover:text-foreground h-9 w-9 -ml-2"
              onClick={() => setIsMobileMenuOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-3">
               <div className="h-5 w-1.5 rounded-full bg-primary/80 hidden sm:block theme-glow-primary"></div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">{currentTitle}</h1>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="theme-control-pill hidden sm:flex">
              <div className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
              </div>
              <span className="font-mono uppercase tracking-wider">System Online</span>
            </div>
            <div className="h-6 w-px bg-border/50 hidden sm:block"></div>
            <div className="hidden md:flex items-center">
              <Select
                value={palette}
                onValueChange={(value) => {
                  if (isColorPalette(value)) {
                    setPalette(value);
                  }
                }}
              >
                <SelectTrigger
                  className="theme-interactive-elevate rounded-full border border-border/60 bg-muted/80 hover:bg-accent/60 transition-all h-9 w-9 p-0 justify-center [&>span]:hidden"
                  title="切换配色方案"
                  aria-label="切换配色方案"
                  hideIndicator
                >
                  <Palette className="h-4 w-4 text-muted-foreground" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cobalt" description="默认 · 钴蓝冷静">Cobalt Blue</SelectItem>
                  <SelectItem value="zinc" description="shadcn · 中性灰阶">Zinc Neutral</SelectItem>
                  <SelectItem value="nord" description="Nord · Arctic Blue">Nord</SelectItem>
                  <SelectItem value="tokyo-night" description="Tokyo Night · Neon Indigo">Tokyo Night</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="theme-interactive-elevate rounded-full border border-border/60 bg-muted/80 hover:bg-accent/60 transition-all h-9 w-9"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              title={resolvedTheme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
            >
              {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              <span className="sr-only">切换主题</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="theme-interactive-elevate rounded-full border border-border/60 bg-muted/80 hover:bg-danger/10 hover:text-danger hover:border-danger/30 transition-all h-9 w-9"
              onClick={handleLogout}
              title="登出"
            >
              <LogOut className="h-4 w-4" />
              <span className="sr-only">登出</span>
            </Button>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto relative">
          <div className="absolute inset-0 bg-background/95 backdrop-blur-[1px] -z-10"></div>
          <div className="absolute inset-0 bg-grid-pattern opacity-[0.025] -z-10"></div>
          <div className={`w-full animate-in fade-in slide-in-from-bottom-4 duration-500 ${(isConfigPage || isNotificationPage || isReviewConfigPage) ? '' : 'p-4 md:p-6 lg:p-8'}`}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
