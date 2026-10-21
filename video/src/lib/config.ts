/**
 * Environment-aware config. One env var swap (`NEXT_PUBLIC_BENCH_SITE_URL`)
 * makes the same code work against staging, production, or a port-local
 * OCB instance — no string-edits across compositions.
 */

export const BENCH_SITE_URL =
  process.env.NEXT_PUBLIC_BENCH_SITE_URL ?? "https://openchainbench.com";

export const benchUrl = (slug: string): string =>
  `${BENCH_SITE_URL}/benchmarks/${slug}`;

export const benchUrlPath = (slug: string): string =>
  `${benchSiteHost()}/benchmarks/${slug}`;

/** Hostname without protocol — used in outro / cite copy where the
 *  `https://` adds noise. */
export function benchSiteHost(): string {
  try {
    return new URL(BENCH_SITE_URL).host;
  } catch {
    return BENCH_SITE_URL.replace(/^https?:\/\//, "");
  }
}

/** MCP endpoint we use to fetch real per-provider time-series. */
export const OCB_MCP_ENDPOINT = `${BENCH_SITE_URL}/api/mcp/mcp`;
