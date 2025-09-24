import { useState } from 'react';
import api from '@/lib/api';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Bot } from 'lucide-react';

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
    } catch (err) {
      setError('登录失败，请检查密码是否正确或查看服务日志。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full lg:grid lg:min-h-screen lg:grid-cols-2">
      <div className="hidden bg-gray-900 lg:flex items-center justify-center">
        <div className="text-center">
            <Bot className="h-24 w-24 text-gray-500 mx-auto mb-6" />
            <h1 className="text-4xl font-bold text-white">Gitea AI Assistant</h1>
            <p className="mt-4 text-gray-400">智能代码审查，自动化您的工作流</p>
        </div>
      </div>
      <div className="flex items-center justify-center py-12 min-h-screen">
        <div className="mx-auto grid w-[350px] gap-6">
          <div className="grid gap-2 text-center">
            <h1 className="text-3xl font-bold">登录</h1>
            <p className="text-balance text-muted-foreground">
              请输入您的管理员密码以继续
            </p>
          </div>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleLogin()}
                required
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button onClick={handleLogin} disabled={isLoading} className="w-full">
              {isLoading ? '验证中...' : '登录'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
