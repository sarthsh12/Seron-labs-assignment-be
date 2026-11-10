import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt is built into Node and deliberately slow and memory-hard, which makes brute-forcing leaked hashes expensive.
const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

// Stored as "scrypt$N$r$p$salt$hash" so parameters can be raised later without breaking old hashes.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, rr, pp, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(rr), p: Number(pp) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Compared against when the email is unknown, so a failed login takes the same time either way.
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));
