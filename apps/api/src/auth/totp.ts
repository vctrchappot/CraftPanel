import crypto from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps,
 * 6 digits), compatible with Google Authenticator, Aegis, 1Password, etc.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, as recommended by RFC 4226. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Check a code against the current step and one step either side (clock
 * drift). Returns the matched step, or null. Steps at or before `lastStep`
 * are rejected so a code cannot be replayed.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, nowMs = Date.now()): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = totpCode(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = "CraftPanel"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- recovery codes ---------------------------------------------------------

/** Ten single-use codes like "k7m2-q9xa", shown once; only their hashes are stored. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(8);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}
