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

export default api;
