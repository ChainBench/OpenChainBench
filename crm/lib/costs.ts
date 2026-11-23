/**
 * What OpenChainBench costs per day, on the two bills that carry it.
 *
 * Vercel: `/v1/billing/charges`, the FOCUS export `vercel usage` reads. One
 * JSON object per line, one line per (service, day, project). Lines tagged
 * with the OCB project id are its usage; lines with no project tag are the
 * team's fixed charges (Pro plan, extra seats, the Flat Rate CDN purchase),
 * which exist for OCB since the other projects on the team are a few cents a
 * day. Other projects (the Mobula ones) are left out. A Vercel day runs 08:00
 * to 08:00 UTC and lands a day or two late, so the newest days are missing,
 * not zero.
 *
 * The amount is `EffectiveCost`, not `BilledCost`. At the start of a billing
 * cycle the plan's included usage credit is consumed first, so BilledCost reads
 * 0 for every project for about two days (2026-10-28 and 29) and a partial
 * third, while EffectiveCost carries the same per-day value as the rest of the
 * month. A daily cost series wants the latter; the cash on the invoice is the
 * former, about the plan's credit lower over a cycle.
 *
 * Railway: there is no money in the API, only usage. `usage(projectId, …)`
 * returns vCPU-minutes, GB-minutes of RAM and disk, and egress GB, and the
 * dollars are those times the Pro list prices below. That reproduced the
 * workspace's `currentUsage` within $0.35 on 2026-10-26. The query is asked
 * one UTC day at a time with both dates set (without them the default window
 * changes with the scope), and rows are SUMMED per measurement because the
 * API can return several per measurement.
 *
 * Past days do not move, so a refresh refetches only the last few days and
 * keeps the rest from the previous snapshot.
 */
import { z } from "zod";

const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN ?? "";
const VERCEL_TEAM = process.env.VERCEL_TEAM_ID ?? "";
const VERCEL_PROJECT = process.env.VERCEL_PROJECT_ID ?? "";
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN ?? "";

/** `id:label` pairs, comma separated. Defaults to the two OCB projects. */
const RAILWAY_PROJECTS = parseProjects(
  process.env.RAILWAY_PROJECTS ??
    "bab1e866-89a4-4aa7-a1d7-c461869c71bd:prod,38962a92-6ada-4e2b-a416-856b056a68c6:staging",
);

/** Days kept in the snapshot, and days refetched on every refresh. */
export const COST_DAYS = 60;
const REFETCH_DAYS = 3;
const TIMEOUT_MS = 60_000;

/** Railway Pro list prices, per unit of what `usage` returns. */
export const RAILWAY_PRICES = {
  CPU_USAGE: 0.000463, // per vCPU-minute
  MEMORY_USAGE_GB: 0.000231, // per GB-minute
  DISK_USAGE_GB: 0.000003472, // per GB-minute
  NETWORK_TX_GB: 0.05, // per GB of egress
} as const;
type Measurement = keyof typeof RAILWAY_PRICES;
const MEASUREMENTS = Object.keys(RAILWAY_PRICES) as Measurement[];

export type CostDay = {
  /** UTC day. For Vercel, the day its 08:00 to 08:00 charge period starts. */
  day: string;
  /** OCB project usage on Vercel; null while Vercel has not billed the day. */
  vercelProject: number | null;
  /** Team charges with no project (plan, seats, CDN flat rate). */
  vercelFixed: number | null;
  /** Railway estimate per project label. */
  railway: Record<string, number>;
};

export type CostLine = { name: string; cost: number };

export type Costs = {
  days: CostDay[];
  railwayProjects: string[];
  /** Vercel OCB usage by service over the last 7 billed days. */
  vercelServices7d: CostLine[];
  /** Vercel fixed charges by name over the last 7 billed days. */
  vercelFixed7d: CostLine[];
  /** Railway cost by measurement over the last 7 days, all projects. */
  railwayMeasurements7d: CostLine[];
  /** Raw Railway usage per day, kept so a price change can be recomputed. */
  railwayUsage: Record<string, Record<string, Partial<Record<Measurement, number>>>>;
  /** Vercel per-service cost per day, for the breakdown. */
  vercelServicesByDay: Record<string, Record<string, number>>;
  vercelFixedByDay: Record<string, Record<string, number>>;
  /** A source that failed on the last refresh while the other succeeded;
   *  its days are the previous refresh's. */
  sourceErrors: string[];
};

export function costsConfigured(): { vercel: boolean; railway: boolean } {
  return {
    vercel: VERCEL_TOKEN.length > 0 && VERCEL_TEAM.length > 0 && VERCEL_PROJECT.length > 0,
    railway: RAILWAY_TOKEN.length > 0 && RAILWAY_PROJECTS.length > 0,
  };
}

function parseProjects(raw: string): { id: string; label: string }[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [id, label] = p.split(":");
      return { id: id.trim(), label: (label ?? id).trim() };
    });
}

function utcDay(offset: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ── Vercel ──

const chargeSchema = z.object({
  EffectiveCost: z.number(),
  ChargePeriodStart: z.string(),
  ServiceName: z.string(),
  Tags: z.record(z.string(), z.string()).nullish(),
});
export type Charge = z.infer<typeof chargeSchema>;

/** Parses the JSONL body; a line that does not match is skipped, not fatal. */
export function parseCharges(body: string): Charge[] {
  const out: Charge[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = chargeSchema.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // a torn line
    }
  }
  return out;
}

/** Charges folded into per-day maps: the OCB project's services, and the
 *  untagged team charges. Other projects' lines are dropped. */
export function foldCharges(charges: Charge[], projectId: string) {
  const services: Record<string, Record<string, number>> = {};
  const fixed: Record<string, Record<string, number>> = {};
  for (const c of charges) {
    if (c.EffectiveCost === 0) continue;
    const day = c.ChargePeriodStart.slice(0, 10);
    const pid = c.Tags?.ProjectId;
    const target = pid === projectId ? services : !pid ? fixed : null;
    if (!target) continue;
    const m = (target[day] ??= {});
    m[c.ServiceName] = (m[c.ServiceName] ?? 0) + c.EffectiveCost;
  }
  return { services, fixed };
}

async function fetchVercelCharges(fromDay: string, toDay: string): Promise<Charge[]> {
  const url =
    `https://api.vercel.com/v1/billing/charges?teamId=${encodeURIComponent(VERCEL_TEAM)}` +
    `&from=${fromDay}T00:00:00Z&to=${toDay}T00:00:00Z`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`vercel billing ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseCharges(await res.text());
}

// ── Railway ──

const usageSchema = z.object({
  data: z
    .object({
      usage: z.array(z.object({ measurement: z.string(), value: z.number() })),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

async function fetchRailwayDay(projectId: string, day: string): Promise<Partial<Record<Measurement, number>>> {
  const end = utcDay(1, new Date(`${day}T00:00:00Z`));
  const query = `query { usage(projectId: "${projectId}", startDate: "${day}T00:00:00Z", endDate: "${end}T00:00:00Z", measurements: [${MEASUREMENTS.join(", ")}]) { measurement value } }`;
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${RAILWAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`railway usage ${res.status}`);
  const parsed = usageSchema.parse(await res.json());
  if (parsed.errors?.length) throw new Error(`railway usage: ${parsed.errors[0].message}`);
  return sumUsage(parsed.data?.usage ?? []);
}

/** Several rows can come back per measurement: they add up. */
export function sumUsage(rows: { measurement: string; value: number }[]): Partial<Record<Measurement, number>> {
  const out: Partial<Record<Measurement, number>> = {};
  for (const r of rows) {
    if (!(r.measurement in RAILWAY_PRICES)) continue;
    const m = r.measurement as Measurement;
    out[m] = (out[m] ?? 0) + r.value;
  }
  return out;
}

export function railwayCost(u: Partial<Record<Measurement, number>>): number {
  return MEASUREMENTS.reduce((s, m) => s + (u[m] ?? 0) * RAILWAY_PRICES[m], 0);
}

// ── shaping ──

const sum = (m: Record<string, number> | undefined) => (m ? Object.values(m).reduce((s, v) => s + v, 0) : 0);

/** Pure: the stored maps into the series and breakdowns the page reads. */
export function shapeCosts(input: {
  today: string;
  railwayProjects: string[];
  railwayUsage: Costs["railwayUsage"];
  vercelServicesByDay: Costs["vercelServicesByDay"];
  vercelFixedByDay: Costs["vercelFixedByDay"];
}): Costs {
  const { today, railwayProjects, railwayUsage, vercelServicesByDay, vercelFixedByDay } = input;
  const first = utcDay(-(COST_DAYS - 1), new Date(`${today}T00:00:00Z`));
  const keep = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([d]) => d >= first && d <= today));
  const ru = keep(railwayUsage);
  const vs = keep(vercelServicesByDay);
  const vf = keep(vercelFixedByDay);

  const days: CostDay[] = [];
  for (let i = COST_DAYS - 1; i >= 0; i--) {
    const day = utcDay(-i, new Date(`${today}T00:00:00Z`));
    const billed = day in vs || day in vf;
    const railway: Record<string, number> = {};
    for (const p of railwayProjects) {
      const u = ru[day]?.[p];
      if (u) railway[p] = railwayCost(u);
    }
    if (!billed && Object.keys(railway).length === 0) continue;
    days.push({
      day,
      vercelProject: billed ? sum(vs[day]) : null,
      vercelFixed: billed ? sum(vf[day]) : null,
      railway,
    });
  }

  const billedDays = days.filter((d) => d.vercelProject != null).slice(-7).map((d) => d.day);
  const lines = (byDay: Record<string, Record<string, number>>, ds: string[]) => {
    const t = new Map<string, number>();
    for (const d of ds) for (const [k, v] of Object.entries(byDay[d] ?? {})) t.set(k, (t.get(k) ?? 0) + v);
    return [...t.entries()].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost);
  };
  const last7 = days.slice(-7).map((d) => d.day);
  const meas = new Map<string, number>();
  for (const d of last7)
    for (const p of railwayProjects)
      for (const m of MEASUREMENTS) {
        const v = ru[d]?.[p]?.[m];
        if (v) meas.set(m, (meas.get(m) ?? 0) + v * RAILWAY_PRICES[m]);
      }

  return {
    days,
    railwayProjects,
    vercelServices7d: lines(vs, billedDays),
    vercelFixed7d: lines(vf, billedDays),
    railwayMeasurements7d: [...meas.entries()].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost),
    railwayUsage: ru,
    vercelServicesByDay: vs,
    vercelFixedByDay: vf,
    sourceErrors: [],
  };
}

/** Daily total: Vercel (project + fixed) plus every Railway project. */
export function dayTotal(d: CostDay): number {
  return (d.vercelProject ?? 0) + (d.vercelFixed ?? 0) + Object.values(d.railway).reduce((s, v) => s + v, 0);
}

/**
 * One refresh. Days already held are kept; the first run (or a day missing
 * from the store) fetches the whole window, later runs only the last
 * REFETCH_DAYS. Either source can be unconfigured; both failing throws so the
 * section keeps its previous value.
 */
export async function loadCosts(prev: Costs | null): Promise<Costs> {
  const conf = costsConfigured();
  if (!conf.vercel && !conf.railway) throw new Error("no billing source configured (VERCEL_API_TOKEN, RAILWAY_API_TOKEN)");
  const today = utcDay(0);
  const first = utcDay(-(COST_DAYS - 1));
  const labels = RAILWAY_PROJECTS.map((p) => p.label);

  const railwayUsage: Costs["railwayUsage"] = { ...(prev?.railwayUsage ?? {}) };
  const vercelServicesByDay: Costs["vercelServicesByDay"] = { ...(prev?.vercelServicesByDay ?? {}) };
  const vercelFixedByDay: Costs["vercelFixedByDay"] = { ...(prev?.vercelFixedByDay ?? {}) };
  const errors: string[] = [];

  if (conf.vercel) {
    try {
      // Vercel lags: refetch from a few days before the newest billed day.
      const held = Object.keys(vercelServicesByDay).filter((d) => d >= first).sort();
      const from = held.length >= COST_DAYS - 7 ? utcDay(-REFETCH_DAYS, new Date(`${held[held.length - 1]}T00:00:00Z`)) : first;
      const { services, fixed } = foldCharges(await fetchVercelCharges(from, utcDay(1)), VERCEL_PROJECT);
      for (const d of Object.keys(vercelServicesByDay)) if (d >= from) delete vercelServicesByDay[d];
      for (const d of Object.keys(vercelFixedByDay)) if (d >= from) delete vercelFixedByDay[d];
      Object.assign(vercelServicesByDay, services);
      Object.assign(vercelFixedByDay, fixed);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (conf.railway) {
    try {
      const recent = utcDay(-REFETCH_DAYS);
      for (let i = COST_DAYS - 1; i >= 0; i--) {
        const day = utcDay(-i);
        for (const p of RAILWAY_PROJECTS) {
          if (day < recent && railwayUsage[day]?.[p.label]) continue;
          const u = await fetchRailwayDay(p.id, day);
          (railwayUsage[day] ??= {})[p.label] = u;
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (errors.length === Number(conf.vercel) + Number(conf.railway)) throw new Error(errors.join("; "));
  if (errors.length) console.warn("[costs]", errors.join("; "));
  return { ...shapeCosts({ today, railwayProjects: labels, railwayUsage, vercelServicesByDay, vercelFixedByDay }), sourceErrors: errors };
}
