import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.jwtSecret);

export interface AccessTokenClaims {
  userId: number;
  sessionId: string;
}

export async function signAccessToken({ userId, sessionId }: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.sid !== 'string') return null;
    return { userId: Number(payload.sub), sessionId: payload.sid };
  } catch {
    return null;
  }
}

// Refresh tokens are random strings, not JWTs; only their SHA-256 hash is stored.
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
