import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios from 'axios'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // 4xx 客户端错误（如 401 未授权）不重试
        if (axios.isAxiosError(error) && error.response) {
          const status = error.response.status;
          if (status >= 400 && status < 500) return false;
        }
        // 其他错误最多重试 2 次
        return failureCount < 2;
      },
    },
  },
});

// Force dark mode as requested
document.documentElement.classList.add('dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
