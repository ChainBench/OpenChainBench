/**
 * The PostHog side of the snapshot: one fixed list of HogQL queries per
 * refresh (nineteen today), each mapped to a plain JSON section. Every query is
 * scoped to the production host, so staging and localhost never count, and
 * to one named event: `$pageview` for the traffic sections, the three custom
 * events of src/lib/analytics.ts for the Actions sections (autocapture is off).
 *
 * Distinct id, not person id: the site runs `person_profiles: identified_only`
 * and never identifies anyone, so a visitor is a device cookie.
 */
import { classifyPath, classifyReferrer, referrerPredicate, type Channel, type Section } from "@/lib/channels";
import { num, queryHogQL, str } from "@/lib/posthog";

const SITE_HOST = process.env.SITE_HOST ?? "openchainbench.com";
const HOST_FILTER = `properties.$host = '${SITE_HOST}'`;
const PV = `event = '$pageview' AND ${HOST_FILTER}`;
// The site's custom events (src/lib/analytics.ts): outbound_click, copy, search.
const CUSTOM = `event IN ('outbound_click', 'copy', 'search') AND ${HOST_FILTER}`;
const PL = `event = '$pageleave' AND ${HOST_FILTER}`;
// Server-side reads the browser never renders (src/lib/analytics-server.ts,
// 2026-09-24): the Markdown views, /api/stat and /api/citable. Markdown is
// one event per read; stat and citable sit behind an edge cache and count
// cache fills, which the dashboard says next to the figures.
const SERVER_READS = `event IN ('markdown_read', 'stat_read', 'citable_read') AND ${HOST_FILTER}`;
const SURFACES = `event IN ('$pageview', 'markdown_read', 'stat_read', 'citable_read') AND ${HOST_FILTER}`;

export type DailyPoint = { day: string; pageviews: number; visitors: number; sessions: number; ai: number; search: number };
/** One cohort week, and how many of it came back n weeks later. */
export type RetentionRow = { cohort: string; week: number; visitors: number };
/** How many visitors were active on exactly `days` distinct days. */
export type FrequencyRow = { days: number; visitors: number };
export type WeeklyPoint = { week: string; visitors: number; ai: number; search: number; pageviews: number };
export type PageRow = { path: string; section: Section; visitors: number; prevVisitors: number; pageviews: number };
export type ReferrerRow = { domain: string; channel: Channel; visitors: number; prevVisitors: number; pageviews: number };
export type NamedCount = { name: string; visitors: number; share: number };
export type EntryRow = { path: string; section: Section; sessions: number };
export type ActionRow = { name: string; count: number; prevCount: number; visitors: number };
export type OutboundRow = { host: string; clicks: number; prevClicks: number; visitors: number; topPage: string };
export type SearchRow = { query: string; count: number; kind: string; url: string };
export type CopyRow = { kind: string; value: string; bench: string; count: number };
export type VitalsRow = { device: string; samples: number; lcpP75: number; inpP75: number; clsP75: number; fcpP75: number };
export type EngagedRow = { section: Section; leaves: number; medianSec: number; p75Sec: number };
export type EngagedPageRow = { path: string; section: Section; leaves: number; medianSec: number };
export type NotFoundRow = { path: string; hits: number; visitors: number; topReferrer: string };
export type NoResultRow = { query: string; count: number };
/** One day of reads per surface: HTML pageviews and the three server-side read events. */
export type SurfacePoint = { day: string; pageviews: number; markdown: number; stat: number; citable: number };
export type EndpointRow = { event: string; path: string; reads: number; prevReads: number; agents: number; families: string[] };
export type FamilyRow = { event: string; family: string; reads: number };
export type AudienceDay = { day: string; visitors: number; newVisitors: number; returningVisitors: number; sessions: number; pageviews: number };
export type BounceDay = { day: string; sessions: number; bounced: number };

export type Traffic = {
  daily: DailyPoint[];
  weekly: WeeklyPoint[];
  pages: PageRow[];
  entries: EntryRow[];
  referrers: ReferrerRow[];
  countries: NamedCount[];
  devices: NamedCount[];
  utm: { source: string; medium: string; visitors: number }[];
  /** GA4 definitions over the 7-day window: active = any pageview in the
   *  window; new = first pageview ever inside the window; returning = active
   *  and seen on an earlier day than their last one (a visitor can be both
   *  new and returning in the same week, as in GA4). Measurable from the
   *  second day of history, unlike "first seen before the window". */
  audience: { activeVisitors: number; newVisitors: number; returningVisitors: number };
  /** Daily audience series over the trailing 90 days: uniques, new, returning, sessions, pageviews. */
  audienceDaily: AudienceDay[];
  /** Daily sessions and single-pageview sessions, for the bounce rate over time. */
  bounceDaily: BounceDay[];
  /** Daily reads per surface over the trailing 90 days (or since the first event). */
  surfaces: SurfacePoint[];
  endpoints: EndpointRow[];
  families: FamilyRow[];
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
  actions: ActionRow[];
  outbound: OutboundRow[];
  searches: SearchRow[];
  copies: CopyRow[];
  vitals: VitalsRow[];
  engaged: EngagedRow[];
  engagedPages: EngagedPageRow[];
  notFound: NotFoundRow[];
  noResults: NoResultRow[];
  retention: RetentionRow[];
  frequency: FrequencyRow[];
};

export const QUERIES = {
  daily: () => `
    SELECT toDate(timestamp) AS day, count() AS pageviews, uniq(distinct_id) AS visitors, uniq(properties.$session_id) AS sessions,
           uniqIf(distinct_id, ${referrerPredicate("ai")}) AS ai,
           uniqIf(distinct_id, ${referrerPredicate("search")}) AS search
    FROM events
    WHERE ${PV} AND timestamp >= toStartOfDay(now() - INTERVAL 27 DAY)
    GROUP BY day ORDER BY day`,
  weekly: () => `
    SELECT toStartOfWeek(timestamp, 1) AS week,
           uniq(distinct_id) AS visitors,
           uniqIf(distinct_id, ${referrerPredicate("ai")}) AS ai,
           uniqIf(distinct_id, ${referrerPredicate("search")}) AS search,
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
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY AND ${referrerPredicate("ai")}) AS ai_visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY AND ${referrerPredicate("ai")}) AS prev_ai_visitors,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY AND ${referrerPredicate("search")}) AS search_visitors,
           uniqIf(distinct_id, timestamp < now() - INTERVAL 7 DAY AND ${referrerPredicate("search")}) AS prev_search_visitors
    FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 14 DAY`,
  audience: () => `
    SELECT count() AS active_visitors,
           countIf(first_seen >= now() - INTERVAL 7 DAY) AS new_visitors,
           countIf(toDate(first_seen) < toDate(last_seen)) AS returning_visitors
    FROM (
      SELECT distinct_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen
      FROM events WHERE ${PV} GROUP BY distinct_id
    ) WHERE last_seen >= now() - INTERVAL 7 DAY`,
  audienceDaily: () => `
    SELECT day, uniq(distinct_id) AS visitors,
           uniqIf(distinct_id, first_day = day) AS new_visitors,
           uniqIf(distinct_id, first_day < day) AS returning_visitors,
           uniq(s) AS sessions, count() AS pageviews
    FROM (
      SELECT toDate(e.timestamp) AS day, e.distinct_id AS distinct_id, e.properties.$session_id AS s, f.first_day AS first_day
      FROM events e
      INNER JOIN (SELECT distinct_id, min(toDate(timestamp)) AS first_day FROM events WHERE ${PV} GROUP BY distinct_id) f ON e.distinct_id = f.distinct_id
      WHERE e.event = '$pageview' AND e.properties.$host = '${SITE_HOST}' AND e.timestamp >= toStartOfDay(now() - INTERVAL 89 DAY)
    ) GROUP BY day ORDER BY day`,
  bounceDaily: () => `
    SELECT day, count() AS sessions, countIf(n = 1) AS bounced FROM (
      SELECT toDate(min(timestamp)) AS day, properties.$session_id AS s, count() AS n
      FROM events WHERE ${PV} AND timestamp >= toStartOfDay(now() - INTERVAL 89 DAY) AND s IS NOT NULL GROUP BY s
    ) GROUP BY day ORDER BY day`,
  surfaces: () => `
    SELECT toDate(timestamp) AS day,
           countIf(event = '$pageview') AS pageviews,
           countIf(event = 'markdown_read') AS markdown,
           countIf(event = 'stat_read') AS stat,
           countIf(event = 'citable_read') AS citable
    FROM events
    WHERE ${SURFACES} AND timestamp >= toStartOfDay(now() - INTERVAL 89 DAY)
    GROUP BY day ORDER BY day`,
  endpoints: () => `
    SELECT event, properties.path AS path,
           countIf(timestamp >= now() - INTERVAL 7 DAY) AS reads,
           countIf(timestamp < now() - INTERVAL 7 DAY) AS prev_reads,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS agents,
           topK(3)(properties.ua_family) AS families
    FROM events WHERE ${SERVER_READS} AND timestamp >= now() - INTERVAL 14 DAY
    GROUP BY event, path ORDER BY greatest(reads, prev_reads) DESC LIMIT 80`,
  families: () => `
    SELECT event, properties.ua_family AS family, count() AS reads
    FROM events WHERE ${SERVER_READS} AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY event, family ORDER BY reads DESC LIMIT 60`,
  engagement: () => `
    SELECT avg(n) AS pages_per_session, countIf(n = 1) / count() AS bounce_rate, count() AS sessions FROM (
      SELECT properties.$session_id AS s, count() AS n
      FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 7 DAY AND s IS NOT NULL GROUP BY s
    )`,
  actions: () => `
    SELECT event, countIf(timestamp >= now() - INTERVAL 7 DAY) AS n, countIf(timestamp < now() - INTERVAL 7 DAY) AS prev_n,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS visitors
    FROM events WHERE ${CUSTOM} AND timestamp >= now() - INTERVAL 14 DAY
    GROUP BY event ORDER BY n DESC`,
  outbound: () => `
    SELECT properties.host AS host, countIf(timestamp >= now() - INTERVAL 7 DAY) AS clicks, countIf(timestamp < now() - INTERVAL 7 DAY) AS prev_clicks,
           uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS visitors, topK(1)(properties.page) AS top_page
    FROM events WHERE event = 'outbound_click' AND ${HOST_FILTER} AND timestamp >= now() - INTERVAL 14 DAY
    GROUP BY host ORDER BY greatest(clicks, prev_clicks) DESC LIMIT 40`,
  searches: () => `
    SELECT lower(properties.query) AS q, count() AS n, topK(1)(properties.kind) AS kind, topK(1)(properties.url) AS url
    FROM events WHERE event = 'search' AND ${HOST_FILTER} AND timestamp >= now() - INTERVAL 7 DAY AND q != ''
    GROUP BY q ORDER BY n DESC LIMIT 40`,
  copies: () => `
    SELECT properties.kind AS kind, properties.value AS value, properties.bench AS bench, count() AS n
    FROM events WHERE event = 'copy' AND ${HOST_FILTER} AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY kind, value, bench ORDER BY n DESC LIMIT 40`,
  vitals: () => `
    SELECT properties.$device_type AS device, count() AS samples,
           quantile(0.75)(toFloat(properties.$web_vitals_LCP_value)) AS lcp,
           quantile(0.75)(toFloat(properties.$web_vitals_INP_value)) AS inp,
           quantile(0.75)(toFloat(properties.$web_vitals_CLS_value)) AS cls,
           quantile(0.75)(toFloat(properties.$web_vitals_FCP_value)) AS fcp
    FROM events WHERE event = '$web_vitals' AND ${HOST_FILTER} AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY device ORDER BY samples DESC LIMIT 4`,
  engaged: () => `
    SELECT properties.$prev_pageview_pathname AS path, count() AS leaves,
           quantile(0.5)(toFloat(properties.$prev_pageview_duration)) AS med,
           quantile(0.75)(toFloat(properties.$prev_pageview_duration)) AS p75
    FROM events WHERE ${PL} AND timestamp >= now() - INTERVAL 7 DAY
      AND properties.$prev_pageview_duration IS NOT NULL AND toFloat(properties.$prev_pageview_duration) BETWEEN 0 AND 1800
    GROUP BY path ORDER BY leaves DESC LIMIT 1500`,
  notFound: () => `
    SELECT properties.path AS path, count() AS hits, uniq(distinct_id) AS visitors, topK(1)(properties.referrer) AS ref
    FROM events WHERE event = 'not_found' AND ${HOST_FILTER} AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY path ORDER BY hits DESC LIMIT 40`,
  noResults: () => `
    SELECT lower(properties.query) AS q, count() AS n
    FROM events WHERE event = 'search_no_result' AND ${HOST_FILTER} AND timestamp >= now() - INTERVAL 7 DAY AND q != ''
    GROUP BY q ORDER BY n DESC LIMIT 40`,
  // Weekly cohorts. The inner query is deliberately unbounded in time so
  // a visitor's cohort is the week they were first seen ever, not the
  // first week of the window: bound it and everyone already active looks
  // like a new arrival and week 0 is inflated. groupUniqArray collapses
  // each visitor to the distinct weeks they appeared in before the
  // arrayJoin fans them back out, so this stays one pass grouped by
  // visitor rather than a self-join over events.
  retention: () => `
    SELECT cohort, dateDiff('week', cohort, wk) AS n, uniq(distinct_id) AS visitors
    FROM (
      SELECT distinct_id,
             toStartOfWeek(min(timestamp), 1) AS cohort,
             arrayJoin(groupUniqArray(toStartOfWeek(timestamp, 1))) AS wk
      FROM events WHERE ${PV} GROUP BY distinct_id
    )
    WHERE cohort >= toStartOfWeek(now() - INTERVAL 76 DAY, 1) AND wk >= cohort
    GROUP BY cohort, n ORDER BY cohort, n`,
  // Retention says whether they came back; this says how often. Distinct
  // active days per visitor over 28 days, as a distribution.
  frequency: () => `
    SELECT days, count() AS visitors FROM (
      SELECT distinct_id, uniq(toDate(timestamp)) AS days
      FROM events WHERE ${PV} AND timestamp >= now() - INTERVAL 28 DAY
      GROUP BY distinct_id
    ) GROUP BY days ORDER BY days LIMIT 40`,
} as const;

export type TrafficSection = keyof typeof QUERIES;
export const TRAFFIC_SECTIONS = Object.keys(QUERIES) as TrafficSection[];

/** Runs one section; the caller decides what a failure means for the snapshot. */
export async function loadTrafficSection(section: TrafficSection): Promise<Partial<Traffic>> {
  const rows = await queryHogQL(section, QUERIES[section]());
  switch (section) {
    case "daily":
      return {
        daily: rows.map((r) => ({
          day: str(r[0]).slice(0, 10),
          pageviews: num(r[1]),
          visitors: num(r[2]),
          sessions: num(r[3]),
          ai: num(r[4]),
          search: num(r[5]),
        })),
      };
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
    case "retention":
      return { retention: rows.map((r) => ({ cohort: str(r[0]).slice(0, 10), week: num(r[1]), visitors: num(r[2]) })) };
    case "frequency":
      return { frequency: rows.map((r) => ({ days: num(r[0]), visitors: num(r[1]) })) };
    case "audience":
      return { audience: { activeVisitors: num(rows[0]?.[0]), newVisitors: num(rows[0]?.[1]), returningVisitors: num(rows[0]?.[2]) } };
    case "audienceDaily":
      return {
        audienceDaily: rows.map((r) => ({ day: str(r[0]).slice(0, 10), visitors: num(r[1]), newVisitors: num(r[2]), returningVisitors: num(r[3]), sessions: num(r[4]), pageviews: num(r[5]) })),
      };
    case "bounceDaily":
      return { bounceDaily: rows.map((r) => ({ day: str(r[0]).slice(0, 10), sessions: num(r[1]), bounced: num(r[2]) })) };
    case "surfaces":
      return { surfaces: rows.map((r) => ({ day: str(r[0]).slice(0, 10), pageviews: num(r[1]), markdown: num(r[2]), stat: num(r[3]), citable: num(r[4]) })) };
    case "endpoints":
      return {
        endpoints: rows.map((r) => ({
          event: str(r[0]),
          path: str(r[1]) || "/",
          reads: num(r[2]),
          prevReads: num(r[3]),
          agents: num(r[4]),
          families: (Array.isArray(r[5]) ? r[5] : [r[5]]).map((f) => str(f)).filter(Boolean),
        })),
      };
    case "families":
      return { families: rows.map((r) => ({ event: str(r[0]), family: str(r[1]) || "unknown", reads: num(r[2]) })) };
    case "actions":
      return { actions: rows.map((r) => ({ name: str(r[0]), count: num(r[1]), prevCount: num(r[2]), visitors: num(r[3]) })) };
    case "outbound":
      return {
        outbound: rows.map((r) => ({ host: str(r[0]) || "?", clicks: num(r[1]), prevClicks: num(r[2]), visitors: num(r[3]), topPage: str(Array.isArray(r[4]) ? r[4][0] : r[4]) })),
      };
    case "searches":
      return { searches: rows.map((r) => ({ query: str(r[0]), count: num(r[1]), kind: str(Array.isArray(r[2]) ? r[2][0] : r[2]), url: str(Array.isArray(r[3]) ? r[3][0] : r[3]) })) };
    case "copies":
      return { copies: rows.map((r) => ({ kind: str(r[0]) || "other", value: str(r[1]), bench: str(r[2]), count: num(r[3]) })) };
    case "vitals":
      return { vitals: rows.map((r) => ({ device: str(r[0]) || "unknown", samples: num(r[1]), lcpP75: num(r[2]), inpP75: num(r[3]), clsP75: num(r[4]), fcpP75: num(r[5]) })) };
    case "engaged": {
      const pages = rows.map((r) => ({ path: str(r[0]) || "/", section: classifyPath(str(r[0])), leaves: num(r[1]), medianSec: num(r[2]), p75Sec: num(r[3]) }));
      return { engagedPages: pages.filter((p) => p.leaves >= 3).slice(0, 40), engaged: engagedBySection(pages) };
    }
    case "notFound":
      return { notFound: rows.map((r) => ({ path: str(r[0]) || "/", hits: num(r[1]), visitors: num(r[2]), topReferrer: str(Array.isArray(r[3]) ? r[3][0] : r[3]) })) };
    case "noResults":
      return { noResults: rows.map((r) => ({ query: str(r[0]), count: num(r[1]) })) };
    case "engagement":
      return { engagement: { pagesPerSession: num(rows[0]?.[0]), bounceRate: num(rows[0]?.[1]), sessions: num(rows[0]?.[2]) } };
  }
}

/** Per-section engaged time: the leave-weighted median of the page medians
 *  (the exact section median would need every duration, 1500 page rows is the
 *  budget). Good enough to rank sections, labelled as such on the page. */
export function engagedBySection(pages: { section: Section; leaves: number; medianSec: number; p75Sec: number }[]): EngagedRow[] {
  const by = new Map<Section, { leaves: number; meds: [number, number][]; p75s: [number, number][] }>();
  for (const p of pages) {
    const cur = by.get(p.section) ?? { leaves: 0, meds: [], p75s: [] };
    cur.leaves += p.leaves;
    cur.meds.push([p.medianSec, p.leaves]);
    cur.p75s.push([p.p75Sec, p.leaves]);
    by.set(p.section, cur);
  }
  const wmedian = (xs: [number, number][]) => {
    const sorted = [...xs].sort((a, b) => a[0] - b[0]);
    const total = sorted.reduce((a, x) => a + x[1], 0);
    let acc = 0;
    for (const [v, w] of sorted) {
      acc += w;
      if (acc >= total / 2) return v;
    }
    return sorted.at(-1)?.[0] ?? 0;
  };
  return [...by.entries()]
    .map(([section, v]) => ({ section, leaves: v.leaves, medianSec: wmedian(v.meds), p75Sec: wmedian(v.p75s) }))
    .sort((a, b) => b.leaves - a.leaves);
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
