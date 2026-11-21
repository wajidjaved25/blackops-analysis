import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP = 30;

export function base32(buf: Buffer): string {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('');
}
export function unbase32(s: string): Buffer {
  const bits = [...s.replace(/=+$/, '').toUpperCase()].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

/** RFC 6238 TOTP (HMAC-SHA1 by default; the RFC test vectors also use SHA256/512). */
export function totp(secret: Buffer, timeMs: number, digits = 6, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / STEP)));
  const h = createHmac(algo, secret).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/** Returns the matching time step (±1 window) or null. `lastStep` blocks replay of an already used code. */
export function verifyTotp(secretB32: string, code: string, now = Date.now(), lastStep = 0): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = unbase32(secretB32);
  const cur = Math.floor(now / 1000 / STEP);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (step > lastStep && totp(key, step * STEP * 1000) === code) return step;
  }
  return null;
}

export const newSecret = () => base32(randomBytes(20));
export const otpauthUrl = (email: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent('Tracera')}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent('Tracera')}&algorithm=SHA1&digits=6&period=${STEP}`;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => {
    const h = randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  return { codes, hashes: codes.map(sha256) };
}
export const recoveryHash = (input: string) => sha256(input.trim().toLowerCase());

// ----- secret at rest: AES-256-GCM with a key derived from APP_SECRET (stored as plain text if it is not set) -----
const key = () => (process.env.APP_SECRET ? createHash('sha256').update(process.env.APP_SECRET).digest() : null);

export function sealSecret(s: string): string {
  const k = key();
  if (!k) return 'plain:' + s;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function openSecret(s: string): string {
  if (s.startsWith('plain:')) return s.slice(6);
  const k = key();
  if (!k || !s.startsWith('enc:')) throw new Error('Cannot decrypt 2FA secret: APP_SECRET is missing or changed');
  const b = Buffer.from(s.slice(4), 'base64');
  const d = createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
