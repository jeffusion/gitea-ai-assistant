import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { LoginPage } from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import { RepositoryManager } from './components/RepositoryManager';
import { ConfigManager } from './components/ConfigManager';
import { ReviewConfigPage } from './components/ReviewConfigPage';
import { Toaster } from "@/components/ui/sonner"

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <div className="absolute h-full w-full rounded-full border-b-2 border-primary animate-spin"></div>
            <div className="absolute h-8 w-8 rounded-full border-t-2 border-primary/50 animate-spin opacity-50" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}></div>
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse"></div>
          </div>
          <div className="text-sm font-mono tracking-widest text-primary/80 animate-pulse">INITIALIZING...</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <AuthGuard>
              <DashboardPage />
            </AuthGuard>
          }
        >
          <Route index element={<Navigate to="/repos" replace />} />
          <Route path="repos" element={<RepositoryManager />} />
          <Route path="config" element={<ConfigManager />} />
          <Route path="review-config" element={<ReviewConfigPage />} />
          <Route path="*" element={<Navigate to="/repos" replace />} />
        </Route>
      </Routes>
      <Toaster theme="dark" />
    </BrowserRouter>
  );
}

export default App;
