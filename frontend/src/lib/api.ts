import axios from 'axios';

const api = axios.create({
  baseURL: '/admin/api',
});

// 添加请求拦截器，在每个请求中自动附加JWT
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 添加响应拦截器，处理 401 未授权自动跳转登录页
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      localStorage.removeItem('authToken');
      // 避免在登录接口本身触发跳转
      const isLoginRequest = error.config?.url?.includes('/login');
      if (!isLoginRequest) {
        window.location.href = '/';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
