import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { EXPORT_VIDEO_ENABLED } from "@/lib/export-video/config";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Server proxy for the OCB Export Video modal. Forwards POSTs to the
 * standalone Remotion renderer service (a small Node app running on a
 * VPS behind Cloudflare) so the auth token stays server-side and the
 * browser never touches our renderer directly.
 *
 * Flag-gated by NEXT_PUBLIC_EXPORT_VIDEO so the surface stays dark in
 * production until the staging soak passes.
 *
 * Renderer response shape: `{ url: "/v/<hash>.mp4", cached: boolean, ms: number }`.
 * `url` is relative to the renderer host; we rewrite it to an absolute
 * URL before returning so the modal can embed it in a <video> tag
 * without knowing the upstream origin.
 */
export async function POST(req: Request) {
  if (!EXPORT_VIDEO_ENABLED) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }

  const r = rateLimit(clientKey(req, "video_render"), 30, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const upstream = process.env.VIDEO_RENDERER_URL;
  const token = process.env.RENDER_API_TOKEN;
  if (!upstream || !token) {
    return NextResponse.json(
      { error: "renderer_not_configured" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${upstream}/render`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Render-Token": token,
      },
      body: JSON.stringify(body),
      // Renderer's full pipeline takes ~30s worst case; allow 120s
      // before we abort and surface an error to the client.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "upstream_unreachable", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: "upstream_error", status: res.status, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  const data = (await res.json()) as { url?: string; cached?: boolean; ms?: number };
  if (typeof data.url !== "string") {
    return NextResponse.json({ error: "bad_upstream_response" }, { status: 502 });
  }

  // Rewrite the relative URL to an absolute one against the renderer host.
  const absoluteUrl = data.url.startsWith("http")
    ? data.url
    : `${upstream.replace(/\/$/, "")}${data.url}`;

  return NextResponse.json({
    url: absoluteUrl,
    cached: !!data.cached,
    ms: data.ms ?? 0,
  });
}
