import { randomBytes, randomUUID } from 'node:crypto';

/** Primary-key generator. UUID v4 from the Node runtime — no DB extension needed. */
export function newId(): string {
  return randomUUID();
}

/** A URL-safe random secret for agent tokens (the part after the token id). */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Basic UUID shape check for client-supplied ids (local-first note creation). */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
