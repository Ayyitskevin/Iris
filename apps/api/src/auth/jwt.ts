import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env';

const secret = new TextEncoder().encode(env.jwtSecret);

export interface SessionClaims {
  /** user id */
  sub: string;
  /** workspace id — the tenant boundary is baked into the session (ADR-003). */
  wid: string;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ wid: claims.wid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secret);
  if (typeof payload.sub !== 'string' || typeof payload.wid !== 'string') {
    throw new Error('Malformed session token');
  }
  return { sub: payload.sub, wid: payload.wid };
}
