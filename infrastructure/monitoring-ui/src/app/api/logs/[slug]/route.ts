import { NextResponse } from "next/server";
import { REGISTRY } from "@/lib/registry";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const tail = url.searchParams.get("tail") ?? "300";
  const region = url.searchParams.get("region");

  const entry = REGISTRY.find((e) => e.slug === slug);
  if (!entry) {
    return NextResponse.json({ error: "unknown slug" }, { status: 404 });
  }
  const h = entry.harness;
  if (h.type === "none") {
    return NextResponse.json({ error: "no harness for this bench" }, { status: 404 });
  }

  let target = h.logsUrl;
  if (h.type === "railway" && region && h.extraRegions) {
    const r = h.extraRegions.find((x) => x.region === region);
    if (r) target = r.logsUrl;
  }
  const targetUrl = target.includes("?") ? `${target}&tail=${tail}` : `${target}?tail=${tail}`;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        ...(h.type === "railway"
          ? { "X-Logs-Token": process.env.LOGS_TOKEN ?? "" }
          : h.type === "ovh-systemd"
          ? { Authorization: `Basic ${Buffer.from(process.env.OVH_CADDY_AUTH ?? "").toString("base64")}` }
          : {}),
      },
      cache: "no-store",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `fetch failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
