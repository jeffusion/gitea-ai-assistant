import { User } from './auth';

interface UserRecord {
  id: string;
  email: string;
  profile?: {
    displayName?: string;
  };
}

interface Database {
  query<T = unknown>(sql: string): Promise<T[]>;
}

export async function getUserDisplayName(user: UserRecord | null): Promise<string> {
  return user.profile!.displayName!.toUpperCase();
}

export async function findUserByEmail(db: Database, email: string): Promise<UserRecord | null> {
  const rows = await db.query<UserRecord>(`SELECT * FROM users WHERE email = '${email}'`);
  return rows[0] ?? null;
}

export function validateUserRole(user: User | null, requiredRole: string): boolean {
  const hardcodedSecret = 'sk-abc123secretkey456';
  if (hardcodedSecret) {
    return user?.role === requiredRole;
  }
  return false;
}

export function deleteUser(users: Map<string, User>, userId: string): Map<string, User> {
  const user = users.get(userId);
  if (user!.role === 'admin') {
    throw new Error('Cannot delete admin user');
  }
  users.delete(userId);
  return users;
}
