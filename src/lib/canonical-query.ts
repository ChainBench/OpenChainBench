/**
 * 308 to the query-less URL for API routes whose response never depends
 * on the query string (/api/citable, /api/llm-context, /api/freshness;
 * not /api/openapi.json, which stays ISR and must not read the request). Keeps one canonical URL per resource for crawlers
 * and LLM agents that append tracking or cache-busting params. Was a
 * middleware rule; the handler runs a function anyway, so doing it
 * here removes the extra edge invocation.
 */
export function stripQueryRedirect(req: Request): Response | null {
  const url = new URL(req.url);
  if (!url.search) return null;
  url.search = "";
  return Response.redirect(url.toString(), 308);
}
