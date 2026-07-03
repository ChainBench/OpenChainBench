// POST /api/chart — returns timeseries in the shape the original recharts UI
// expects: { data: [{ timestamp_ms, value, label }, ...] }.
// All series are flattened together; the chart Line dataKey="value" plots
// every row regardless of label, which is how the original delete-ui showed
// "all regions/chains overlaid" without per-series logic.
//
// Hardened: metric allowlist + label parser + hours bound + read rate limit.

import { NextRequest, NextResponse } from "next/server";
import { promRead } from "@/app/lib/prom";
import { allowRead } from "@/app/lib/rate-limit";
import { buildMatcher, isAllowedMetric, parseLabels } from "@/app/lib/validate";

export async function POST(req: NextRequest) {
	const user = req.headers.get("x-admin-user") ?? "unknown";
	if (!allowRead(user)) return NextResponse.json({ error: "rate limit" }, { status: 429 });

	const body = await req.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return NextResponse.json({ error: "invalid body" }, { status: 400 });
	}
	const { metric, labels, hours } = body as { metric?: string; labels?: string; hours?: number };

	if (!metric || !isAllowedMetric(metric)) {
		return NextResponse.json({ error: `metric "${metric}" not allowed` }, { status: 400 });
	}
	const h = typeof hours === "number" ? hours : Number.parseFloat(String(hours ?? "24"));
	if (!Number.isFinite(h) || h <= 0 || h > 168) {
		return NextResponse.json({ error: "hours must be 0 < h <= 168" }, { status: 400 });
	}
	let pairs;
	try {
		pairs = parseLabels(labels ?? "");
	} catch (e: unknown) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : "labels invalid" },
			{ status: 400 },
		);
	}

	const matcher = buildMatcher(metric, pairs);
	const endTs = Math.floor(Date.now() / 1000);
	const startTs = endTs - Math.round(h * 3600);
	const q = `avg_over_time(${matcher}[1m])`;
	const url = `/api/v1/query_range?query=${encodeURIComponent(q)}&start=${startTs}&end=${endTs}&step=60`;
	const r = await promRead(url);
	const j = (await r.json()) as {
		data?: { result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
	};

	const chartData: Array<{ timestamp: number; value: number; label: string }> = [];
	for (const s of j.data?.result ?? []) {
		const seriesLabel = Object.entries(s.metric)
			.filter(([k]) => !k.startsWith("__"))
			.map(([k, v]) => `${k}=${v}`)
			.join(", ");
		for (const [ts, v] of s.values) {
			chartData.push({
				timestamp: ts * 1000,
				value: Number.parseFloat(v),
				label: seriesLabel,
			});
		}
	}
	chartData.sort((a, b) => a.timestamp - b.timestamp);
	return NextResponse.json({ data: chartData });
}
