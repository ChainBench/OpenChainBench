import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 15;
export const preferredRegion = ["cdg1", "fra1", "ams1"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "dydx100vgggy9jxn3z2q4a9wy58un8ejp79zdtgaqv5";

  const params = new URLSearchParams({ address, subaccountNumber: "0", limit: "10" });
  const fetchUrl = `https://indexer.dydx.trade/v4/fills?${params}`;

  try {
    const res = await fetch(fetchUrl, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    const status = res.status;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return NextResponse.json({ fetchUrl, status, ok: res.ok, body });
  } catch (err) {
    return NextResponse.json({ fetchUrl, error: String(err) }, { status: 500 });
  }
}
