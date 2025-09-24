import { useAuth } from './hooks/useAuth';
import { LoginPage } from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import { Toaster } from "@/components/ui/sonner"

function App() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div>正在加载...</div>
      </div>
    );
  }

  const Page = isAuthenticated ? DashboardPage : LoginPage;

  return (
    <>
      <Page />
      <Toaster theme="dark" />
    </>
  );
}

export default App;
