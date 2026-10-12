import { getTerminalFills } from "@/lib/terminal-fills";
import { stripQueryRedirect } from "@/lib/canonical-query";

export const runtime = "nodejs";

/**
 * The sampled swaps behind bench 268, for the audit table on the
 * terminal-fill-quality and terminal-execution-quality bench pages.
 *
 * The table used to receive all ~3,000 rows as a client-component prop,
 * which serialised them into the page: 2.4 MB of HTML on each of the two
 * pages, ~85% of it this array, written to the ISR cache on every
 * regeneration and shipped to every visitor although 50 rows are shown.
 * The page now embeds the 50 most recent and the table fetches the rest
 * from here after hydration. CDN-cached on the harness JSON's own 5 min
 * cadence.
 */
export async function GET(req: Request) {
  const canonical = stripQueryRedirect(req);
  if (canonical) return canonical;
  const f = await getTerminalFills();
  if (!f) return Response.json({ error: "unavailable" }, { status: 404 });
  return Response.json(
    { generatedAt: f.generatedAt, swaps: f.recent },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600, max-age=60" } },
  );
}
