export interface User {
  id: string;
  name: string;
  role: 'user' | 'admin';
}

const users = new Map<string, User>([
  ['token-user', { id: 'u1', name: 'Alice', role: 'user' }],
  ['token-admin', { id: 'u2', name: 'Bob', role: 'admin' }],
]);

export function authenticate(token: string): User | null {
  if (!token.trim()) {
    return null;
  }

  return users.get(token) ?? null;
}

export function requireAdmin(user: User | null): boolean {
  return user?.role === 'admin';
}
