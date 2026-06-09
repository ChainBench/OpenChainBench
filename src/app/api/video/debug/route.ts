import { NextResponse } from "next/server";

// Temporary debug — to delete once we've diagnosed the env var pickup
// issue. Reveals presence + length only, never the secret value.
export const runtime = "nodejs";

export async function GET() {
  const flag = process.env.NEXT_PUBLIC_EXPORT_VIDEO;
  const url = process.env.VIDEO_RENDERER_URL;
  const token = process.env.RENDER_API_TOKEN;
  return NextResponse.json({
    NEXT_PUBLIC_EXPORT_VIDEO: {
      present: flag !== undefined,
      value: flag,
      len: flag?.length ?? null,
      equals_1: flag === "1",
    },
    VIDEO_RENDERER_URL: {
      present: url !== undefined,
      len: url?.length ?? null,
      starts_with_https: url?.startsWith("https://") ?? false,
    },
    RENDER_API_TOKEN: {
      present: token !== undefined,
      len: token?.length ?? null,
    },
    VERCEL_ENV: process.env.VERCEL_ENV,
    NODE_ENV: process.env.NODE_ENV,
  });
}
