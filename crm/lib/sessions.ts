/**
 * Issued sessions, on the volume next to the snapshot: {nonce: expiresAtMs}.
 * A session is valid when its cookie signature checks out (lib/auth.ts) AND
 * its nonce is still listed here, so logout revokes it for real and the list
 * is the only state. Read through an mtime check: proxy.ts calls this on
 * every request, from a different bundler layer than the routes that write.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), ".snapshots");
const FILE = path.join(DIR, "sessions.json");

type Store = Record<string, number>;
let cache: { mtimeMs: number; data: Store } | null = null;

async function read(): Promise<Store> {
  try {
    const st = await fs.stat(FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.data;
    const data = JSON.parse(await fs.readFile(FILE, "utf8")) as Store;
    cache = { mtimeMs: st.mtimeMs, data: data && typeof data === "object" ? data : {} };
    return cache.data;
  } catch {
    return {};
  }
}

async function write(data: Store): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, FILE);
  cache = null;
}

function prune(data: Store, now: number): Store {
  const out: Store = {};
  for (const [k, exp] of Object.entries(data)) if (typeof exp === "number" && exp > now) out[k] = exp;
  return out;
}

export async function sessionListed(nonce: string, now = Date.now()): Promise<boolean> {
  const exp = (await read())[nonce];
  return typeof exp === "number" && exp > now;
}

export async function listSession(nonce: string, expiresAtMs: number, now = Date.now()): Promise<void> {
  const data = prune(await read(), now);
  data[nonce] = expiresAtMs;
  await write(data);
}

export async function unlistSession(nonce: string, now = Date.now()): Promise<void> {
  const data = prune(await read(), now);
  delete data[nonce];
  await write(data);
}
