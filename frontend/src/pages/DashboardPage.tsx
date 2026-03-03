import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { LogOut, Bot, FolderGit2, Sliders, Menu, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const navItems = [
  { path: '/repos', label: '仓库管理', icon: FolderGit2 },
  { path: '/config', label: '配置管理', icon: Sliders },
] as const;

export default function DashboardPage() {
  const location = useLocation();
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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden animate-in fade-in"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside 
        className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-zinc-950 transition-all duration-300 ease-in-out lg:relative ${
          isSidebarCollapsed ? 'w-[72px]' : 'w-64'
        } ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className="flex h-16 items-center justify-between px-4 border-b border-border/50 bg-zinc-950">
          <div className={`flex items-center gap-3 overflow-hidden transition-all duration-300 ${isSidebarCollapsed ? 'w-10 justify-center -ml-1' : 'w-full'}`}>
            <div className="flex shrink-0 h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(20,184,166,0.15)] ring-1 ring-primary/10">
              <Bot className="h-5 w-5" />
            </div>
            {!isSidebarCollapsed && (
              <span className="truncate font-bold tracking-tight text-zinc-100 whitespace-nowrap">
                Gitea AI Assistant
              </span>
            )}
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="lg:hidden shrink-0 h-8 w-8 text-zinc-400 hover:text-zinc-100"
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
                  `group relative flex w-full items-center rounded-xl p-2.5 transition-all duration-200 ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                  } ${isSidebarCollapsed ? 'justify-center' : 'justify-start gap-3'}`
                }
                title={isSidebarCollapsed ? item.label : undefined}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <div className="absolute left-0 top-1/2 h-1/2 w-1 -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_10px_rgba(20,184,166,0.5)]"></div>
                    )}
                    <Icon className={`h-5 w-5 shrink-0 transition-transform duration-300 ${isActive ? 'text-primary scale-110' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
                    {!isSidebarCollapsed && (
                      <span className="font-medium tracking-wide text-sm">{item.label}</span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-border/50 p-3 bg-zinc-950">
          <button
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            className={`hidden lg:flex w-full items-center rounded-xl p-2.5 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300 ${
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
      <div className="flex flex-1 flex-col overflow-hidden relative">
        {/* Top Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 px-4 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              className="lg:hidden text-zinc-400 hover:text-zinc-100 h-9 w-9 -ml-2"
              onClick={() => setIsMobileMenuOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="h-5 w-1.5 rounded-full bg-primary/80 hidden sm:block shadow-[0_0_8px_rgba(20,184,166,0.4)]"></div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">{currentTitle}</h1>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border border-border/50 bg-zinc-900/50">
              <div className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </div>
              <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">System Online</span>
            </div>
            <div className="h-6 w-px bg-border/50 hidden sm:block"></div>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full border border-border/50 bg-zinc-900 hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/20 transition-all h-9 w-9"
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
          <div className="absolute inset-0 bg-grid-pattern opacity-[0.03] -z-10"></div>
          <div className={`mx-auto max-w-7xl animate-in fade-in slide-in-from-bottom-4 duration-500 ${isConfigPage ? '' : 'p-4 md:p-6 lg:p-8'}`}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
