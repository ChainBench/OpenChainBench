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
import { isWindowed, loadTrafficSection, TRAFFIC_SECTIONS, type Traffic } from "@/lib/traffic";
import { WINDOWS, type ReportWindow, type WindowKey } from "@/lib/window";

// 15 min by default: 48 queries per pass (28 sections over 7 d plus the 20
// windowed ones repeated over 24 h), 192 an hour, 8 % of PostHog's
// organisation budget; the Railway cost does not move with this number, the
// container is always on and a pass is about 80 s of light CPU.
export const REFRESH_MINUTES = clampInt(process.env.REFRESH_MINUTES, 15, 5, 24 * 60);
/** A manual refresh is refused while the last one is younger than this. */
export const MANUAL_COOLDOWN_MINUTES = 5;

const DIR = process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), ".snapshots");
const FILE = path.join(DIR, "snapshot.json");
const HISTORY = path.join(DIR, "history.jsonl");

export type SectionStatus = { at: string | null; error: string | null };

export type Snapshot = {
  v: 1;
  refreshedAt: string | null;
  posthogConfigured: boolean;
  traffic: Partial<Traffic>;
  /** The same windowed sections over 24 h, for ?w=24h. The long series
   *  (the 28-day and 90-day charts, the weekly cohorts) are not repeated
   *  here: they mean the same thing whatever window the reader picked, so
   *  a 24 h page reads them from `traffic`. */
  traffic24h: Partial<Traffic>;
  benches: BenchHealth | null;
  harness: HarnessHealth | null;
  dune: DuneUsage | null;
  status: Record<string, SectionStatus>;
  budget: { used: number; limit: number };
};

export type HistoryLine = {
  day: string;
  visitors7d: number;
  pageviews7d: number;
  aiVisitors7d: number;
  searchVisitors7d: number;
  benches: number;
  stale: number;
  targetsDown: number;
};

const EMPTY: Snapshot = { v: 1, refreshedAt: null, posthogConfigured: posthogConfigured(), traffic: {}, traffic24h: {}, benches: null, harness: null, dune: null, status: {}, budget: { used: 0, limit: HOURLY_BUDGET } };

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Module state lives on globalThis: Next bundles instrumentation.ts (the
// scheduler) and the app routes in separate layers, and a module reached
// from two layers is two instances. The file is the source of truth and is
// re-read whenever its mtime moved, so a refresh from the scheduler, from
// the CLI or from another process is seen by the next request.
type Shared = { cache: { mtimeMs: number; snapshot: Snapshot } | null; running: Promise<Snapshot> | null };
const g = globalThis as unknown as { __ocbSnapshot?: Shared };
const shared: Shared = (g.__ocbSnapshot ??= { cache: null, running: null });

export async function readSnapshot(): Promise<Snapshot> {
  try {
    const st = await fs.stat(FILE);
    if (shared.cache && shared.cache.mtimeMs === st.mtimeMs) return shared.cache.snapshot;
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as Snapshot;
    if (parsed && parsed.v === 1) {
      const snapshot = { ...EMPTY, ...parsed, posthogConfigured: posthogConfigured() };
      shared.cache = { mtimeMs: st.mtimeMs, snapshot };
      return snapshot;
    }
  } catch {
    // first boot, or an unreadable file: start empty
  }
  return { ...EMPTY };
}

async function writeSnapshot(s: Snapshot): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, FILE);
  shared.cache = null;
}

/** Parses the journal: one JSON object per line, the last line of a day
 *  wins, unparsable lines are skipped (never the whole file). */
export function parseHistory(raw: string): HistoryLine[] {
  const byDay = new Map<string, HistoryLine>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const l = JSON.parse(line) as HistoryLine;
      if (l && typeof l.day === "string") byDay.set(l.day, l);
    } catch {
      // a torn write; the other lines still count
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export async function readHistory(): Promise<HistoryLine[]> {
  try {
    return parseHistory(await fs.readFile(HISTORY, "utf8"));
  } catch {
    return [];
  }
}

/** Append only: one line per refresh, deduped per UTC day on read. */
async function appendHistory(s: Snapshot): Promise<void> {
  const t = s.traffic;
  const line: HistoryLine = {
    day: new Date().toISOString().slice(0, 10),
    visitors7d: t.totals?.visitors ?? 0,
    pageviews7d: t.totals?.pageviews ?? 0,
    aiVisitors7d: t.totals?.aiVisitors ?? 0,
    searchVisitors7d: t.totals?.searchVisitors ?? 0,
    benches: s.benches?.total ?? 0,
    stale: (s.benches?.stale ?? 0) + (s.benches?.expired ?? 0),
    targetsDown: s.harness?.down.length ?? 0,
  };
  await fs.mkdir(DIR, { recursive: true });
  await fs.appendFile(HISTORY, `${JSON.stringify(line)}\n`);
}

export type RefreshResult = { snapshot: Snapshot; ran: string[]; failed: string[]; stoppedBy: string | null; joined: boolean };

/** Rebuilds the snapshot. Concurrent calls join the run in progress. */
export function refreshSnapshot(reason: string): Promise<RefreshResult> {
  if (shared.running) return shared.running.then((snapshot) => ({ snapshot, ran: [], failed: [], stoppedBy: null, joined: true }));
  const p = doRefresh(reason);
  shared.running = p.then((r) => r.snapshot);
  // The shared promise is released whichever way the run ends; the caller
  // of `p` still sees the rejection.
  void shared.running.catch(() => undefined).finally(() => {
    shared.running = null;
  });
  return p;
}

async function doRefresh(reason: string): Promise<RefreshResult> {
  const started = Date.now();
  const prev = await readSnapshot();
  const next: Snapshot = { ...prev, traffic: { ...prev.traffic }, traffic24h: { ...prev.traffic24h }, status: { ...prev.status }, posthogConfigured: posthogConfigured() };
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
    // The "not configured" note from earlier refreshes must not outlive the fix.
    delete next.status.posthog;
    try {
      // The 7 d pass runs every section, including the long series and the
      // kiosk list that the 24 h pass then reuses (kiosks is first in the
      // list and this loop is sequential, so the ids are known by the time
      // any other query is built).
      for (const section of TRAFFIC_SECTIONS) {
        await step(statusKey(section, WINDOWS["7d"]), async () => {
          Object.assign(next.traffic, await loadTrafficSection(section, WINDOWS["7d"]));
        });
      }
      // The second window repeats only what moves with it.
      for (const section of TRAFFIC_SECTIONS) {
        if (!isWindowed(section)) continue;
        await step(statusKey(section, WINDOWS["24h"]), async () => {
          Object.assign(next.traffic24h, await loadTrafficSection(section, WINDOWS["24h"]));
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

  // Sections that no longer exist (a loader removed, e.g. gsc and the
  // Vercel log drain on 2026-09-22) keep their last status in the stored
  // snapshot and the header goes on reporting them as failing. Only the
  // keys this build can produce survive a refresh.
  const knownSections = new Set([
    "benches",
    "harness",
    "dune",
    "posthog",
    ...TRAFFIC_SECTIONS.map((s) => statusKey(s, WINDOWS["7d"])),
    ...TRAFFIC_SECTIONS.filter(isWindowed).map((s) => statusKey(s, WINDOWS["24h"])),
  ]);
  for (const key of Object.keys(next.status)) {
    if (!knownSections.has(key)) delete next.status[key];
  }

  next.refreshedAt = stamp();
  next.budget = { used: budget.used(), limit: HOURLY_BUDGET };
  await writeSnapshot(next);
  await appendHistory(next).catch((e) => console.warn("[refresh] history:", e));
  console.log(`[refresh] ${reason}: ${ran.length} sections in ${Date.now() - started} ms, ${failed.length} failed${stoppedBy ? `, stopped: ${stoppedBy}` : ""}`);
  return { snapshot: next, ran, failed, stoppedBy, joined: false };
}

/** Status key for one section in one window. The default window keeps the
 *  bare `traffic.<section>` name it has always had, so a stored snapshot's
 *  statuses survive this change instead of being swept as unknown. */
export function statusKey(section: string, w: ReportWindow): string {
  return w.key === "7d" ? `traffic.${section}` : `traffic.${section}@${w.key}`;
}

/** The windowed slice a page should read. */
export function trafficFor(s: Snapshot, key: WindowKey): Partial<Traffic> {
  return key === "24h" ? { ...s.traffic, ...s.traffic24h } : s.traffic;
}

export function snapshotAgeMinutes(s: Snapshot, now = Date.now()): number | null {
  const t = Date.parse(s.refreshedAt ?? "");
  return Number.isFinite(t) ? (now - t) / 60_000 : null;
}
