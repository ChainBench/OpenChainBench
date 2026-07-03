// GET /api/labels — returns the dimension values for head_lag_seconds{aggregator="mobula"}
// in the shape the original delete-ui expects: { chains: ['All', ...], regions: ['All', ...] }.
//
// Reuses promRead (no bearer needed). Rate-limited.

import { NextRequest, NextResponse } from "next/server";
import { promRead } from "@/app/lib/prom";
import { allowRead } from "@/app/lib/rate-limit";

export async function GET(req: NextRequest) {
	const user = req.headers.get("x-admin-user") ?? "unknown";
	if (!allowRead(user)) return NextResponse.json({ error: "rate limit" }, { status: 429 });

	const r = await promRead('/api/v1/query?query=head_lag_seconds{aggregator="mobula"}');
	const j = (await r.json()) as {
		data?: { result?: Array<{ metric: Record<string, string> }> };
	};
	const chains = new Set<string>();
	const regions = new Set<string>();
	for (const s of j.data?.result ?? []) {
		if (s.metric.chain) chains.add(s.metric.chain);
		if (s.metric.region) regions.add(s.metric.region);
	}
	return NextResponse.json({
		chains: ["All", ...Array.from(chains).sort()],
		regions: ["All", ...Array.from(regions).sort()],
	});
}
