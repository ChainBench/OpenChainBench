// POST /api/preview — read-only count of how many samples a selector would
// touch. Used by the UI to populate "this will delete N points" before the
// destructive confirmation. No bearer needed (uses promRead, not promAdmin).

import { NextRequest, NextResponse } from "next/server";
import { promRead } from "@/app/lib/prom";
import { audit, newRequestId } from "@/app/lib/audit";
import { allowRead } from "@/app/lib/rate-limit";
import {
	buildMatcher,
	isAllowedMetric,
	parseLabels,
	serializeLabels,
	validateRange,
} from "@/app/lib/validate";

export async function POST(req: NextRequest) {
	const user = req.headers.get("x-admin-user") ?? "unknown";
	const requestId = newRequestId();

	if (!allowRead(user)) {
		return NextResponse.json({ error: "rate limit (20 reads/min)" }, { status: 429 });
	}

	const body = await req.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return NextResponse.json({ error: "invalid body" }, { status: 400 });
	}
	const { metric, labels, startTime, endTime } = body as {
		metric?: string;
		labels?: string;
		startTime?: string;
		endTime?: string;
	};

	if (!metric || !isAllowedMetric(metric)) {
		return NextResponse.json({ error: `metric "${metric}" is not allowed` }, { status: 400 });
	}
	if (!startTime || !endTime) {
		return NextResponse.json({ error: "startTime and endTime required" }, { status: 400 });
	}
	let range: ReturnType<typeof validateRange>;
	try {
		range = validateRange(startTime, endTime);
	} catch (e: unknown) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : "range invalid" },
			{ status: 400 },
		);
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
	const window = range.endTs - range.startTs;
	const q = `count(count_over_time(${matcher}[${window}s] @ ${range.endTs}))`;
	const url = `/api/v1/query?query=${encodeURIComponent(q)}`;
	const r = await promRead(url);
	const j = (await r.json()) as { data?: { result?: Array<{ value?: [number, string] }> } };
	const seriesCount = j.data?.result?.[0]?.value?.[1]
		? Number.parseInt(j.data.result[0].value[1], 10)
		: 0;

	audit({
		user,
		action: "preview",
		metric,
		labels: labels ?? "",
		start_ts: range.startTs,
		end_ts: range.endTs,
		series_count: seriesCount,
		result: "ok",
		request_id: requestId,
	});

	return NextResponse.json({
		ok: true,
		matcher,
		labels_normalized: serializeLabels(pairs),
		series_count: seriesCount,
		start_ts: range.startTs,
		end_ts: range.endTs,
	});
}
