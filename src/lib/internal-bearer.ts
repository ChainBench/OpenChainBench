import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./sha256";

export type BearerCheck = "authorized" | "unauthorized" | "unconfigured";

const sha256 = (value: string): Buffer =>
  Buffer.from(sha256Hex(value), "hex");

const readSecret = (name: string) => (process.env[name] ?? "").trim();

export function checkBearer(
  req: Request,
  [primary, ...alternates]: readonly [string, ...string[]],
  { minLength = 1 }: { minLength?: number } = {},
): BearerCheck {
  if (readSecret(primary) === "") return "unconfigured";
  const secrets = [primary, ...alternates]
    .map(readSecret)
    .filter((s) => s.length > 0);
  if (secrets.some((s) => s.length < minLength)) return "unconfigured";
  const provided = sha256((req.headers.get("authorization") ?? "").trim());
  const matches = secrets.map((s) =>
    timingSafeEqual(provided, sha256(`Bearer ${s}`)),
  );
  return matches.includes(true) ? "authorized" : "unauthorized";
}

export function cronAuthorized(req: Request): boolean {
  const auth = checkBearer(req, ["CRON_SECRET"]);
  if (auth === "unconfigured") return process.env.NODE_ENV !== "production";
  return auth === "authorized";
}
