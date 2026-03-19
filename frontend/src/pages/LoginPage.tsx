import { useState } from 'react';
import api from '@/lib/api';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bot, Terminal, ShieldCheck, ArrowRight, Activity } from 'lucide-react';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    setError('');
    setIsLoading(true);
    try {
      const response = await api.post('/login', { password });
      const { token } = response.data;
      if (token) {
        localStorage.setItem('authToken', token);
        window.location.reload();
      } else {
        setError('登录失败，返回的 token 为空。');
      }
    } catch {
      setError('登录失败，请检查密码是否正确或查看服务日志。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="theme-shell-gradient relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-background">
      {/* Background grid and gradient effects */}
      <div className="absolute inset-0 bg-grid-pattern opacity-[0.04]"></div>
      <div className="absolute top-[-25%] left-[-14%] h-[460px] w-[460px] rounded-full bg-primary/14 blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-26%] right-[-12%] h-[460px] w-[460px] rounded-full bg-accent/20 blur-[120px] pointer-events-none"></div>

      <div className="z-10 w-full max-w-md px-4 sm:px-6 relative">
        <div className="theme-card-shell theme-interactive-elevate relative p-8 sm:p-10">
          {/* Decorative terminal dots */}
          <div className="absolute top-4 left-4 flex gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-danger/80 theme-glow-danger"></div>
            <div className="h-2.5 w-2.5 rounded-full bg-warning/80 theme-glow-warning"></div>
            <div className="h-2.5 w-2.5 rounded-full bg-success/80 theme-glow-success"></div>
          </div>

          <div className="mb-10 mt-6 flex flex-col items-center text-center">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/70 border border-primary/20 theme-glow-primary ring-1 ring-primary/10 relative group">
              <div className="absolute inset-0 rounded-2xl bg-accent/80 blur-md opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <Bot className="h-8 w-8 text-primary relative z-10" />
            </div>
            <h1 className="mb-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Gitea AI Assistant</h1>
            <div className="theme-control-pill text-primary/80">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              [SYSTEM] authentication_required
            </div>
          </div>

          <div className="grid gap-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-xs font-mono font-medium text-muted-foreground flex items-center gap-2">
                  <span className="text-primary font-bold">&gt;</span> enter_admin_password
                </label>
              </div>
              <div className="relative group">
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleLogin()}
                  required
                  placeholder="••••••••"
                  className="theme-input-surface h-12 font-mono placeholder:text-muted-foreground/50 transition-all duration-300"
                />
                <Terminal className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary/70" />
              </div>
            </div>

            {error && (
              <div className="theme-error-panel flex items-start gap-2 px-3 py-3 text-sm animate-in fade-in slide-in-from-top-1">
                <Activity className="h-4 w-4 mt-0.5 shrink-0" />
                <p className="font-mono text-xs leading-relaxed">{error}</p>
              </div>
            )}

            <Button
              onClick={handleLogin}
              disabled={isLoading}
              className="tech-glow group relative mt-4 h-12 w-full overflow-hidden bg-primary text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-70 disabled:pointer-events-none"
            >
              <div className="absolute inset-0 flex h-full w-full justify-center [transform:skew(-12deg)_translateX(-150%)] group-hover:duration-1000 group-hover:[transform:skew(-12deg)_translateX(150%)]">
                <div className="relative h-full w-12 bg-foreground/20"></div>
              </div>
              <span className="relative flex items-center gap-2 font-mono font-semibold tracking-wide">
                {isLoading ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"></div>
                    VERIFYING...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4" />
                    AUTHORIZE
                    <ArrowRight className="h-4 w-4 opacity-70 transition-transform duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
                  </>
                )}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
