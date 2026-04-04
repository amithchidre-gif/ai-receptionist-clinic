import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { getToken, removeToken, removeClinicId } from '../utils/auth';

const api: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: false,
});

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = getToken();
    if (token) {
      config.headers = config.headers || {};
      config.headers['Authorization'] = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response: AxiosResponse) => {
    if (response.data && response.data.success === false && response.data.error) {
      throw new Error(response.data.error);
    }
    return response;
  },
  (error) => {
    if (
      error.response &&
      error.response.status === 401 &&
      typeof window !== 'undefined'
    ) {
      if (window.location.pathname === '/login') {
        throw error;
      }
      alert('Session expired. Please log in again.');
      setTimeout(() => {
        removeToken();
        removeClinicId();
        window.location.href = '/login';
      }, 1500);
    }
    if (
      error.response &&
      error.response.data &&
      error.response.data.error
    ) {
      throw new Error(error.response.data.error);
    }
    throw error;
  }
);

export const get = async (path: string, config?: AxiosRequestConfig) => {
  const res = await api.get(path, config);
  return res.data.data;
};

export const post = async (path: string, body?: any, config?: AxiosRequestConfig) => {
  const res = await api.post(path, body, config);
  return res.data.data;
};

export const patch = async (path: string, body?: any, config?: AxiosRequestConfig) => {
  const res = await api.patch(path, body, config);
  return res.data.data;
};

export const put = async (path: string, body?: any, config?: AxiosRequestConfig) => {
  const res = await api.put(path, body, config);
  return res.data.data;
};

export const del = async (path: string, config?: AxiosRequestConfig) => {
  const res = await api.delete(path, config);
  return res.data.data;
};
