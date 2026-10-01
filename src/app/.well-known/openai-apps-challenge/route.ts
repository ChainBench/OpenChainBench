export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Domain verification for the ChatGPT app directory.
 *
 * Submitting the MCP server at /api/mcp/mcp requires proving we own the
 * hostname serving it: OpenAI issues a token in the submission dashboard and
 * fetches it back as plain text from
 *
 *     https://openchainbench.com/.well-known/openai-apps-challenge
 *
 * The rule the docs are strict about is that the response body must be the
 * token and nothing else. No JSON wrapper, no trailing newline we did not
 * intend, no HTML error page. So this route returns the raw string with an
 * explicit text/plain type rather than going through any of the site's
 * response helpers.
 *
 * The token lives in OPENAI_APPS_CHALLENGE (a Vercel production env var) and
 * not in the repository: it is a per-submission secret, publishing it in git
 * would let anyone else prove ownership of this domain for their own
 * submission. Until it is set the route answers 404, which is the honest
 * state (no challenge outstanding) and is indistinguishable to a crawler
 * from the route not existing.
 *
 * `force-dynamic` because the value is read at request time: rotating the
 * env var must take effect without a rebuild, and a cached empty body during
 * a verification window would fail the check for no visible reason.
 */
export function GET(): Response {
  const token = process.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(token, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      // Verification reads this directly; nothing should index it.
      "x-robots-tag": "noindex",
    },
  });
}
