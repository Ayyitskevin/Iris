/**
 * Secret hashing for passwords and agent tokens. Uses Node's built-in scrypt — no
 * native build step, works everywhere. A managed auth provider (ADR-004) takes over
 * password handling in production; this keeps the local provider self-contained.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

/** Returns a self-describing string: `scrypt$<saltHex>$<hashHex>`. */
export async function hashSecret(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Constant-time verification against a stored `scrypt$salt$hash` string. */
export async function verifySecret(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const derived = await scrypt(plain, salt, expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
