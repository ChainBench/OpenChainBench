// GET /api/metrics — returns the allowlisted metric names that exist in Prom.
// Intersects the server-side allowlist with Prom's `__name__` index so the
// UI never sees a metric it's not allowed to delete.

import { NextRequest, NextResponse } from "next/server";
import { promRead } from "@/app/lib/prom";
import { allowRead } from "@/app/lib/rate-limit";
import { isAllowedMetric } from "@/app/lib/validate";

export async function GET(req: NextRequest) {
	const user = req.headers.get("x-admin-user") ?? "unknown";
	if (!allowRead(user)) {
		return NextResponse.json({ error: "rate limit" }, { status: 429 });
	}
	const r = await promRead("/api/v1/label/__name__/values");
	const j = (await r.json()) as { data?: string[] };
	const allowed = (j.data ?? []).filter(isAllowedMetric).sort();
	return NextResponse.json({ ok: true, metrics: allowed });
}
