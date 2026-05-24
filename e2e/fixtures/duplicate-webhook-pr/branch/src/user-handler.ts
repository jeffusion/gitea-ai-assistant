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
