/**
 * IndexNow client. Pings api.indexnow.org to tell Bing / Yandex / Naver /
 * Seznam that a list of our URLs has changed, so they re-crawl in
 * sub-minute rather than waiting for their own crawl schedule (which can
 * be days).
 *
 * Spec: https://www.indexnow.org/documentation
 *
 * Not currently used by Google (they have their own crawl prioritisation),
 * but improving Bing visibility carries through to ChatGPT browse, Brave,
 * DuckDuckGo, and Yandex / Naver / Seznam in their respective markets.
 *
 * Authentication: the key (random 32-char hex) sits in two places:
 *   1. `process.env.INDEXNOW_KEY` (read at request time)
 *   2. A static file at `https://openchainbench.com/<key>.txt` proving
 *      we control the domain (`public/<key>.txt` in this repo).
 * IndexNow refuses to crawl if the file does not match the submitted key.
 */

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS_PER_REQUEST = 10_000;

export type IndexNowResult = {
  ok: boolean;
  /** HTTP status code returned by the IndexNow endpoint (per batch). */
  status: number;
  /** Number of URLs accepted by the call. */
  submitted: number;
  /** Number of separate POST requests issued (one per 10k-URL batch). */
  batches: number;
  /** Human-readable summary, useful for logs and cron response bodies. */
  message: string;
};

/**
 * Submit a list of URLs to IndexNow. The URLs must all share the same
 * host as the configured INDEXNOW_KEY's key file (IndexNow rejects cross-
 * host batches). Caller is responsible for filtering.
 */
export async function pingIndexNow(
  urls: string[],
  opts: { host: string } = { host: "openchainbench.com" },
): Promise<IndexNowResult> {
  const key = (process.env.INDEXNOW_KEY ?? "").trim();
  if (!key) {
    return {
      ok: false,
      status: 0,
      submitted: 0,
      batches: 0,
      message: "INDEXNOW_KEY not configured",
    };
  }
  if (urls.length === 0) {
    return { ok: true, status: 204, submitted: 0, batches: 0, message: "no urls" };
  }

  // De-dupe + filter to the configured host so a stray /alternative/x
  // URL doesn't poison the batch.
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    try {
      const parsed = new URL(u);
      if (parsed.host !== opts.host) continue;
    } catch {
      continue;
    }
    seen.add(u);
    filtered.push(u);
  }
  if (filtered.length === 0) {
    return {
      ok: true,
      status: 204,
      submitted: 0,
      batches: 0,
      message: "no urls matched host",
    };
  }

  let lastStatus = 0;
  let submitted = 0;
  let batches = 0;
  for (let i = 0; i < filtered.length; i += MAX_URLS_PER_REQUEST) {
    const batch = filtered.slice(i, i + MAX_URLS_PER_REQUEST);
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: opts.host, key, urlList: batch }),
      // IndexNow is fast (sub-second). 10s is more than enough; tighter
      // is better so a cron doesn't hang the Vercel function on a
      // transient upstream outage.
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = res.status;
    batches += 1;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        submitted,
        batches,
        message: `batch ${batches} failed: ${res.status} ${body.slice(0, 200)}`,
      };
    }
    submitted += batch.length;
  }

  return {
    ok: true,
    status: lastStatus,
    submitted,
    batches,
    message: `submitted ${submitted} urls in ${batches} batch${batches > 1 ? "es" : ""}`,
  };
}
