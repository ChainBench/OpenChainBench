import { NextResponse } from "next/server";
import { z } from "zod";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { EXPORT_VIDEO_ENABLED } from "@/lib/export-video/config";
import { SLUG_RE } from "@/lib/slug";
import { VIEW_IDS } from "@/lib/export-video/types";

export const runtime = "nodejs";

// Strict schema for the payload forwarded to the Remotion renderer.
// Belt-and-suspenders even though the renderer has its own X-Render-Token:
// this route is a public POST proxy, so anything not shaped like a legit
// export-video call from the modal must be refused before it reaches
// upstream. Caps mirror the client widget's actual ranges and prevent
// pathological inputs (10k providers, 1M timestamps) from consuming
// renderer CPU/memory.
const ProviderSeriesSchema = z.object({
  slug: z.string().max(80),
  name: z.string().max(200),
  color: z.string().max(32),
  logo: z.string().max(500).optional(),
  values: z.array(z.number()).max(2000),
});
const BenchPayloadSchema = z.object({
  slug: z.string().max(80),
  title: z.string().max(500),
  metric: z.string().max(200),
  unit: z.string().max(40),
  higherIsBetter: z.boolean(),
  timestamps: z.array(z.number().int().nonnegative()).max(2000),
  providers: z.array(ProviderSeriesSchema).max(100),
});
const RenderBodySchema = z.object({
  datasetId: z.string().regex(SLUG_RE),
  viewId: z.enum(VIEW_IDS as [string, ...string[]]),
  raceSeconds: z.number().int().min(1).max(300),
  skipIntro: z.boolean(),
  format: z.enum(["landscape", "short"]),
  audio: z.boolean(),
  beats: z.boolean(),
  bench: BenchPayloadSchema,
}).strict();
// 300s = Vercel Pro Fluid Compute max. Big benches (50+ providers) take
// 90-120s on the 2-vCPU VPS because each frame has to draw all providers.
// 300s gives headroom; we'll move to async polling in v2 to drop this
// requirement entirely.
export const maxDuration = 300;

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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = RenderBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", detail: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }
  const body = parsed.data;

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
      signal: AbortSignal.timeout(290_000),
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
