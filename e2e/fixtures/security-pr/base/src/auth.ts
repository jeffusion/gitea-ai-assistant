export interface TokenPayload {
  sub: string;
  exp: number;
}

export function verifyToken(token: string, expectedToken: string): boolean {
  return token.length > 0 && token === expectedToken;
}

export function isExpired(payload: TokenPayload, now = Date.now()): boolean {
  return payload.exp * 1000 <= now;
}
