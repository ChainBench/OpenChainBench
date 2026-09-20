/**
 * The snapshot is the only thing pages read. A refresh rebuilds it section
 * by section; a section that fails keeps its previous value and records the
 * error, so an upstream blip never blanks the dashboard and a PostHog 429
 * stops the batch instead of the app.
 *
 * Storage is a JSON file (SNAPSHOT_DIR, a Railway volume in production) plus
 * one line per day in history.jsonl with the headline numbers, so the
 * dashboard keeps a record longer than PostHog's retention and independent
 * of it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { budget, BudgetExhausted, HOURLY_BUDGET, posthogConfigured, RateLimited } from "@/lib/posthog";
import { loadBenchHealth, loadDuneUsage, loadHarnessHealth, type BenchHealth, type DuneUsage, type HarnessHealth } from "@/lib/ocb";
import { loadTrafficSection, TRAFFIC_SECTIONS, type Traffic } from "@/lib/traffic";

export const REFRESH_MINUTES = clampInt(process.env.REFRESH_MINUTES, 60, 10, 24 * 60);
/** A manual refresh is refused while the last one is younger than this. */
export const MANUAL_COOLDOWN_MINUTES = 10;

const DIR = process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), ".snapshots");
const FILE = path.join(DIR, "snapshot.json");
const HISTORY = path.join(DIR, "history.jsonl");

export type SectionStatus = { at: string | null; error: string | null };

export type Snapshot = {
  v: 1;
  refreshedAt: string | null;
  posthogConfigured: boolean;
  traffic: Partial<Traffic>;
  benches: BenchHealth | null;
  harness: HarnessHealth | null;
  dune: DuneUsage | null;
  status: Record<string, SectionStatus>;
  budget: { used: number; limit: number };
};

export type HistoryLine = { day: string; visitors7d: number; pageviews7d: number; aiVisitors7d: number; searchVisitors7d: number; benches: number; stale: number; targetsDown: number };

const EMPTY: Snapshot = { v: 1, refreshedAt: null, posthogConfigured: posthogConfigured(), traffic: {}, benches: null, harness: null, dune: null, status: {}, budget: { used: 0, limit: HOURLY_BUDGET } };

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

let memory: Snapshot | null = null;

export async function readSnapshot(): Promise<Snapshot> {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as Snapshot;
    if (parsed && parsed.v === 1) {
      memory = { ...EMPTY, ...parsed, posthogConfigured: posthogConfigured() };
      return memory;
    }
  } catch {
    // first boot, or an unreadable file: start empty
  }
  memory = { ...EMPTY };
  return memory;
}

async function writeSnapshot(s: Snapshot): Promise<void> {
  memory = s;
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, FILE);
}

export async function readHistory(): Promise<HistoryLine[]> {
  try {
    const raw = await fs.readFile(HISTORY, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryLine);
  } catch {
    return [];
  }
}

/** One line per UTC day; the last refresh of the day wins. */
async function appendHistory(s: Snapshot): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const t = s.traffic;
  const lastWeek = t.weekly?.at(-1);
  const line: HistoryLine = {
    day,
    visitors7d: t.totals?.visitors ?? 0,
    pageviews7d: t.totals?.pageviews ?? 0,
    aiVisitors7d: lastWeek?.ai ?? 0,
    searchVisitors7d: lastWeek?.search ?? 0,
    benches: s.benches?.total ?? 0,
    stale: (s.benches?.stale ?? 0) + (s.benches?.expired ?? 0),
    targetsDown: s.harness?.down.length ?? 0,
  };
  const lines = (await readHistory()).filter((l) => l.day !== day);
  lines.push(line);
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(HISTORY, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

let running: Promise<Snapshot> | null = null;

export type RefreshResult = { snapshot: Snapshot; ran: string[]; failed: string[]; stoppedBy: string | null };

/** Rebuilds the snapshot. Concurrent calls share one run. */
export function refreshSnapshot(reason: string): Promise<RefreshResult> {
  if (running) return running.then((snapshot) => ({ snapshot, ran: [], failed: [], stoppedBy: "already running" }));
  const p = doRefresh(reason);
  running = p.then((r) => r.snapshot);
  // The shared promise is released whichever way the run ends; the caller
  // of `p` still sees the rejection.
  void running.catch(() => undefined).finally(() => {
    running = null;
  });
  return p;
}

async function doRefresh(reason: string): Promise<RefreshResult> {
  const started = Date.now();
  const prev = await readSnapshot();
  const next: Snapshot = { ...prev, traffic: { ...prev.traffic }, status: { ...prev.status }, posthogConfigured: posthogConfigured() };
  const ran: string[] = [];
  const failed: string[] = [];
  let stoppedBy: string | null = null;
  const stamp = () => new Date().toISOString();

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      next.status[name] = { at: stamp(), error: null };
      ran.push(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      next.status[name] = { at: prev.status[name]?.at ?? null, error: msg };
      failed.push(name);
      console.warn(`[refresh] ${name}: ${msg}`);
      if (err instanceof RateLimited || err instanceof BudgetExhausted) throw err;
    }
  };

  await step("benches", async () => {
    next.benches = await loadBenchHealth();
  });
  await step("harness", async () => {
    next.harness = await loadHarnessHealth();
  });
  await step("dune", async () => {
    next.dune = await loadDuneUsage();
  });

  if (posthogConfigured()) {
    try {
      for (const section of TRAFFIC_SECTIONS) {
        await step(`traffic.${section}`, async () => {
          Object.assign(next.traffic, await loadTrafficSection(section));
        });
      }
    } catch (err) {
      // A 429 or an exhausted local budget: the remaining sections keep their
      // previous values and the next scheduled refresh retries them.
      stoppedBy = err instanceof Error ? err.message : String(err);
    }
  } else {
    next.status.posthog = { at: null, error: "POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID not set" };
  }

  next.refreshedAt = stamp();
  next.budget = { used: budget.used(), limit: HOURLY_BUDGET };
  await writeSnapshot(next);
  await appendHistory(next).catch((e) => console.warn("[refresh] history:", e));
  console.log(`[refresh] ${reason}: ${ran.length} sections in ${Date.now() - started} ms, ${failed.length} failed${stoppedBy ? `, stopped: ${stoppedBy}` : ""}`);
  return { snapshot: next, ran, failed, stoppedBy };
}

export function snapshotAgeMinutes(s: Snapshot, now = Date.now()): number | null {
  const t = Date.parse(s.refreshedAt ?? "");
  return Number.isFinite(t) ? (now - t) / 60_000 : null;
}
