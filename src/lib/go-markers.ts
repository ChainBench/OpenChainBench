import { createHash } from "node:crypto";
import { z } from "zod";
import { redisCommand, storeConfigured } from "@/lib/materialize/store";

const REPEAT_WINDOW_MS = 3000;
const PASS_TTL_MS = 60 * 60 * 1000;
const REDIS_TIMEOUT_MS = 3000;
const PASS_TIMEOUT_MS = 1000;
const passFormat = z.uuid();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function passKey(pass: string): string {
  return `ocb:go:pass:${digest(pass)}`;
}

async function claim(opener: string, href: string): Promise<boolean> {
  const key = `ocb:go:seen:${digest(opener)}:${digest(href)}`;
  const reply = await redisCommand(
    ["SET", key, "1", "NX", "PX", REPEAT_WINDOW_MS],
    REDIS_TIMEOUT_MS,
  );
  return reply === "OK";
}

export type Claim = "first" | "repeat" | "unchecked";

export async function claimOpening(
  openers: readonly string[],
  href: string,
): Promise<Claim> {
  if (!storeConfigured()) return "unchecked";
  try {
    const claims = await Promise.all(openers.map((o) => claim(o, href)));
    return claims.every(Boolean) ? "first" : "repeat";
  } catch (error) {
    console.error("[go] repeat filter unavailable", error);
    return "unchecked";
  }
}

export async function issuePass(href: string): Promise<string | null> {
  if (!storeConfigured()) return null;
  const pass = crypto.randomUUID();
  try {
    const reply = await redisCommand(
      ["SET", passKey(pass), digest(href), "NX", "PX", PASS_TTL_MS],
      PASS_TIMEOUT_MS,
    );
    return reply === "OK" ? pass : null;
  } catch (error) {
    console.error("[go] continue pass unavailable", error);
    return null;
  }
}

export async function redeemPass(pass: string, href: string): Promise<boolean> {
  if (!storeConfigured() || !passFormat.safeParse(pass).success) return false;
  try {
    const stored = await redisCommand(
      ["GETDEL", passKey(pass)],
      PASS_TIMEOUT_MS,
    );
    return stored === digest(href);
  } catch (error) {
    console.error("[go] continue pass unavailable", error);
    return false;
  }
}
