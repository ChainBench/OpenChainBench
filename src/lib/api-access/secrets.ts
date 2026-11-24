import { randomBytes } from "node:crypto";
import { SECRET_CHARS } from "./contract";

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SECRET_BYTES = 32;
const KEY_PREFIX = "ocb_";
const RADIX = BigInt(BASE62.length);
const ZERO = BigInt(0);

export const API_KEY_PATTERN = new RegExp(
  `^${KEY_PREFIX}[0-9A-Za-z]{${SECRET_CHARS}}$`,
);

function base62(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > ZERO) {
    out = BASE62.charAt(Number(n % RADIX)) + out;
    n /= RADIX;
  }
  return out.padStart(SECRET_CHARS, "0");
}

export function newApiKey(): string {
  return `${KEY_PREFIX}${base62(randomBytes(SECRET_BYTES))}`;
}

export function newStatusToken(): string {
  return base62(randomBytes(SECRET_BYTES));
}
