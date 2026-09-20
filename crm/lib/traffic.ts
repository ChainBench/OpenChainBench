/**
 * The PostHog side of the snapshot: one fixed list of HogQL queries per
 * refresh (ten today), each mapped to a plain JSON section. Every query is
 * scoped to the production host, so staging and localhost never count, and
 * to `$pageview`, the only event the site captures today (autocapture is off).
 *
 * Distinct id, not person id: the site runs `person_profiles: identified_only`
 * and never identifies anyone, so a visitor is a device cookie.
 */
import { AI_DOMAINS, SEARCH_DOMAINS, classifyPath, classifyReferrer, domainInList, type Channel, type Section } from "@/lib/channels";
import { num, queryHogQL, str } from "@/lib/posthog";

const SITE_HOST = process.env.SITE_HOST ?? "openchainbench.com";
const HOST_FILTER = `properties.$host = '${SITE_HOST}'`;
const PV = `event = '$pageview' AND ${HOST_FILTER}`;

export type DailyPoint = { day: string; pageviews: number; visitors: number; sessions: number };
export type WeeklyPoint = { week: string; visitors: number; ai: number; search: number; pageviews: number };
export type PageRow = { path: string; section: Section; visitors: number; prevVisitors: number; pageviews: number };
export type ReferrerRow = { domain: string; channel: Channel; visitors: number; prevVisitors: number; pageviews: number };
export type NamedCount = { name: string; visitors: number; share: number };
export type EntryRow = { path: string; section: Section; sessions: number };

export type Traffic = {
  daily: DailyPoint[];
  weekly: WeeklyPoint[];
  pages: PageRow[];
  entries: EntryRow[];
  referrers: ReferrerRow[];
  countries: NamedCount[];
  devices: NamedCount[];
  utm: { source: string; medium: string; visitors: number }[];
  audience: { newVisitors: number; returningVisitors: number };
  totals: {
    visitors: number;
    prevVisitors: number;
    pageviews: number;
    prevPageviews: number;
    sessions: number;
    prevSessions: number;
    /** Distinct visitors whose pageview carried an AI assistant referrer; exact uniques, unlike the per-domain sum. */
    aiVisitors: number;
    prevAiVisitors: number;
    searchVisitors: number;
    prevSearchVisitors: number;
  };
  engagement: { pagesPerSession: number; bounceRate: number; sessions: number };
};

export const QUERIES = {
  daily: () => `
    SELECT toDate(timestamp) AS day, count() AS pageviews, uniq(distinct_id) AS visitors, uniq(properties.$session_id) AS sessions
    FROM events
    WHERE ${PV} AND timestamp >= toStartOfDay(now() - INTERVAL 27 DAY)
    GROUP BY day ORDER BY day`,
  weekly: () => `
    SELECT toStartOfWeek(timestamp, 1) AS week,
           uniq(distinct_id) AS visitors,
           uniqIf(distinct_id, properties.$referring_domain IN (${domainInList(AI_DOMAINS)})) AS ai,
           uniqIf(distinct_id, properties.$referring_domain IN (${domainInList(SEARCH_DOMAINS)})) AS search,
           count() AS pageviews
    FROM events
    WHERE ${PV} AND timestamp >= toStartOfWeek(now() - INTERVAL 11 WEEK, 1)
    GROUP BY week ORDER BY week`,
  pages: () => `
    SELECT properties.$pathname AS path,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY) AS prev_visitors,
           countIf(timestamp >= now() - INTERVAL 7 DAY) AS pageviews
    FROM events
    WHERE ${PV} AND timestamp >= now() - INTERVAL 14 DAY
    GROUP BY path ORDER BY greatest(visitors, prev_visitors) DESC, pageviews DESC LIMIT 2000`,
  entries: () => `
    SELECT path, count() AS sessions FROM (
      SELECT properties.$session_id AS s, argMin(properties.$pathname, timestamp) AS path
      FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 7 DAY GROUP BY s
    ) GROUP BY path ORDER BY sessions DESC LIMIT 40`,
  referrers: () => `
    SELECT properties.$referring_domain AS domain,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY) AS prev_visitors,
           countIf(timestamp >= now() - INTERVAL 7 DAY) AS pageviews
    FROM events
    WHERE ${PV} AND timestamp >= now() - INTERVAL 14 DAY
    GROUP BY domain ORDER BY greatest(visitors, prev_visitors) DESC LIMIT 400`,
  countries: () => `
    SELECT properties.$geoip_country_code AS country, uniq(distinct_id) AS visitors
    FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY country ORDER BY visitors DESC LIMIT 20`,
  devices: () => `
    SELECT properties.$device_type AS device, uniq(distinct_id) AS visitors
    FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY device ORDER BY visitors DESC LIMIT 6`,
  utm: () => `
    SELECT properties.utm_source AS source, properties.utm_medium AS medium, uniq(distinct_id) AS visitors
    FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 7 DAY AND properties.utm_source IS NOT NULL AND properties.utm_source != ''
    GROUP BY source, medium ORDER BY visitors DESC LIMIT 25`,
  totals: () => `
    SELECT uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY) AS prev_visitors,
           countIf(timestamp >= now() - INTERVAL 7 DAY) AS pageviews,
           countIf(timestamp < now() - INTERVAL 7 DAY) AS prev_pageviews,
           uniqIf(properties.$session_id, timestamp >= now() - INTERVAL 7 DAY) AS sessions,
           uniqIf(properties.$session_id, timestamp < now() - INTERVAL 7 DAY) AS prev_sessions,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY AND properties.$referring_domain IN (${domainInList(AI_DOMAINS)})) AS ai_visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY AND properties.$referring_domain IN (${domainInList(AI_DOMAINS)})) AS prev_ai_visitors,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY AND properties.$referring_domain IN (${domainInList(SEARCH_DOMAINS)})) AS search_visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY AND properties.$referring_domain IN (${domainInList(SEARCH_DOMAINS)})) AS prev_search_visitors
    FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 14 DAY`,
  audience: () => `
    SELECT countIf(first_seen >= now() - INTERVAL 7 DAY) AS new_visitors,
           countIf(first_seen < now() - INTERVAL 7 DAY) AS returning_visitors
    FROM (
      SELECT distinct_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen
      FROM events WHERE ${PV} GROUP BY distinct_id
    ) WHERE last_seen >= now() - INTERVAL 7 DAY`,
  engagement: () => `
    SELECT avg(n) AS pages_per_session, countIf(n = 1) / count() AS bounce_rate, count() AS sessions FROM (
      SELECT properties.$session_id AS s, count() AS n
      FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 7 DAY AND s IS NOT NULL GROUP BY s
    )`,
} as const;

export type TrafficSection = keyof typeof QUERIES;
export const TRAFFIC_SECTIONS = Object.keys(QUERIES) as TrafficSection[];

/** Runs one section; the caller decides what a failure means for the snapshot. */
export async function loadTrafficSection(section: TrafficSection): Promise<Partial<Traffic>> {
  const rows = await queryHogQL(section, QUERIES[section]());
  switch (section) {
    case "daily":
      return { daily: rows.map((r) => ({ day: str(r[0]).slice(0, 10), pageviews: num(r[1]), visitors: num(r[2]), sessions: num(r[3]) })) };
    case "weekly":
      return { weekly: rows.map((r) => ({ week: str(r[0]).slice(0, 10), visitors: num(r[1]), ai: num(r[2]), search: num(r[3]), pageviews: num(r[4]) })) };
    case "pages":
      return {
        pages: rows.map((r) => ({ path: str(r[0]) || "/", section: classifyPath(str(r[0])), visitors: num(r[1]), prevVisitors: num(r[2]), pageviews: num(r[3]) })),
      };
    case "entries":
      return { entries: rows.map((r) => ({ path: str(r[0]) || "/", section: classifyPath(str(r[0])), sessions: num(r[1]) })) };
    case "referrers":
      return {
        referrers: rows.map((r) => ({ domain: str(r[0]) || "$direct", channel: classifyReferrer(str(r[0])), visitors: num(r[1]), prevVisitors: num(r[2]), pageviews: num(r[3]) })),
      };
    case "countries":
      return { countries: withShare(rows.map((r) => ({ name: str(r[0]) || "unknown", visitors: num(r[1]) }))) };
    case "devices":
      return { devices: withShare(rows.map((r) => ({ name: str(r[0]) || "unknown", visitors: num(r[1]) }))) };
    case "utm":
      return { utm: rows.map((r) => ({ source: str(r[0]), medium: str(r[1]) || "(none)", visitors: num(r[2]) })) };
    case "totals":
      return {
        totals: {
          visitors: num(rows[0]?.[0]),
          prevVisitors: num(rows[0]?.[1]),
          pageviews: num(rows[0]?.[2]),
          prevPageviews: num(rows[0]?.[3]),
          sessions: num(rows[0]?.[4]),
          prevSessions: num(rows[0]?.[5]),
          aiVisitors: num(rows[0]?.[6]),
          prevAiVisitors: num(rows[0]?.[7]),
          searchVisitors: num(rows[0]?.[8]),
          prevSearchVisitors: num(rows[0]?.[9]),
        },
      };
    case "audience":
      return { audience: { newVisitors: num(rows[0]?.[0]), returningVisitors: num(rows[0]?.[1]) } };
    case "engagement":
      return { engagement: { pagesPerSession: num(rows[0]?.[0]), bounceRate: num(rows[0]?.[1]), sessions: num(rows[0]?.[2]) } };
  }
}

function withShare(rows: { name: string; visitors: number }[]): NamedCount[] {
  const total = rows.reduce((a, r) => a + r.visitors, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? r.visitors / total : 0 }));
}

/** Derived views, computed from the snapshot at render time. */
export function sectionTotals(pages: PageRow[]): { section: Section; visitors: number; prevVisitors: number; pageviews: number; pages: number }[] {
  const acc = new Map<Section, { visitors: number; prevVisitors: number; pageviews: number; pages: number }>();
  for (const p of pages) {
    const cur = acc.get(p.section) ?? { visitors: 0, prevVisitors: 0, pageviews: 0, pages: 0 };
    // Visitors summed over pages overcount a visitor who saw two pages of the
    // section; the column is labelled "page visits" on the dashboard for that reason.
    cur.visitors += p.visitors;
    cur.prevVisitors += p.prevVisitors;
    cur.pageviews += p.pageviews;
    if (p.visitors > 0) cur.pages += 1;
    acc.set(p.section, cur);
  }
  return [...acc.entries()].map(([section, v]) => ({ section, ...v })).sort((a, b) => b.visitors - a.visitors);
}

export function channelTotals(referrers: ReferrerRow[]): { channel: Channel; visitors: number; prevVisitors: number; domains: number }[] {
  const acc = new Map<Channel, { visitors: number; prevVisitors: number; domains: number }>();
  for (const r of referrers) {
    const cur = acc.get(r.channel) ?? { visitors: 0, prevVisitors: 0, domains: 0 };
    cur.visitors += r.visitors;
    cur.prevVisitors += r.prevVisitors;
    if (r.visitors > 0) cur.domains += 1;
    acc.set(r.channel, cur);
  }
  return [...acc.entries()].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.visitors - a.visitors);
}

export function sumWindow(daily: DailyPoint[], days: number, offsetDays = 0): { pageviews: number; visitors: number; sessions: number } {
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  const end = sorted.length - offsetDays;
  const slice = sorted.slice(Math.max(0, end - days), Math.max(0, end));
  return slice.reduce(
    (a, d) => ({ pageviews: a.pageviews + d.pageviews, visitors: a.visitors + d.visitors, sessions: a.sessions + d.sessions }),
    { pageviews: 0, visitors: 0, sessions: 0 },
  );
}
