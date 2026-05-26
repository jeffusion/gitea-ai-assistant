import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { LoginPage } from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import { RepositoryManager } from './components/RepositoryManager';
import { ConfigManager } from './components/ConfigManager';
import { NotificationConfigPage } from './components/NotificationConfigPage';
import { ReviewConfigPage } from './components/ReviewConfigPage';
import ReviewSessionsPage from './pages/ReviewSessionsPage';
import { Toaster } from "@/components/ui/sonner"
import { useTheme } from 'next-themes'
import { ColorPaletteProvider } from './hooks/useColorPalette';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <div className="absolute h-full w-full rounded-full border-b-2 border-primary animate-spin"></div>
            <div className="absolute h-8 w-8 rounded-full border-t-2 border-primary/50 opacity-50 theme-spin-reverse-slow"></div>
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

function AppContent() {
  const { resolvedTheme } = useTheme();

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
          <Route path="notifications" element={<NotificationConfigPage />} />
          <Route path="review-config" element={<ReviewConfigPage />} />
          <Route path="review-runs" element={<ReviewSessionsPage />} />
          <Route path="*" element={<Navigate to="/repos" replace />} />
        </Route>
      </Routes>
      <Toaster theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />
    </BrowserRouter>
  );
}

function App() {
  return (
    <ColorPaletteProvider>
      <AppContent />
    </ColorPaletteProvider>
  );
}

export default App;
