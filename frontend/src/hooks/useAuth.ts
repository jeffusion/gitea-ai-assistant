import { useState, useEffect } from 'react';

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    try {
      const token = localStorage.getItem('authToken');
      setIsAuthenticated(!!token);
    } catch (error) {
      console.error("Failed to read auth token from storage", error);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { isAuthenticated, isLoading };
}
