/**
 * Export Video feature flag + renderer endpoint.
 *
 * Gated by `NEXT_PUBLIC_EXPORT_VIDEO=1` so the button only ships on
 * staging-openchainbench.vercel.app first; production stays dark until
 * the flag is flipped. The render API route reads `VIDEO_RENDERER_URL`
 * + `RENDER_API_TOKEN` server-side (never exposed to the client).
 */
export const EXPORT_VIDEO_ENABLED =
  process.env.NEXT_PUBLIC_EXPORT_VIDEO === "1";
