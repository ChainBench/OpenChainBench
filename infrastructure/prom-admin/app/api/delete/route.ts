// POST /api/delete — wipe a time range for a metric+labels selector.
//
// Security stack:
//   - Basic Auth middleware in front (only authenticated users reach here)
//   - Metric allowlist (server-side, no env override possible)
//   - Strict label parser (no PromQL injection)
//   - Range bound (max MAX_RANGE_HOURS window, max MAX_AGE_DAYS old)
//   - Rate limit (5 destructive actions/h/user)
//   - Audit log on every outcome (preview / delete / denied / error)
//
// The browser-side native confirm() at the UI level is the user-confirmation
// step; the typed-slug was overkill behind Basic Auth + Cloudflare Access.

import { NextRequest, NextResponse } from "next/server";
import { promAdmin, promRead } from "@/app/lib/prom";
import { audit, newRequestId } from "@/app/lib/audit";
import { allowDestructive } from "@/app/lib/rate-limit";
import {
	buildMatcher,
	isAllowedMetric,
	parseLabels,
	validateRange,
} from "@/app/lib/validate";

export async function POST(req: NextRequest) {
	const user = req.headers.get("x-admin-user") ?? "unknown";
	const requestId = newRequestId();

	const body = await req.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return NextResponse.json({ error: "invalid body" }, { status: 400 });
	}
	const { metric, labels, startTime, endTime, threshold, thresholdOp } = body as {
		metric?: string;
		labels?: string;
		startTime?: string;
		endTime?: string;
		threshold?: number;
		thresholdOp?: string;
	};

	const baseAudit = {
		user,
		action: "delete" as const,
		metric: metric ?? "",
		labels: labels ?? "",
		start_ts: 0,
		end_ts: 0,
		request_id: requestId,
	};

	if (!allowDestructive(user)) {
		audit({ ...baseAudit, result: "denied", reason: "rate_limit" });
		return NextResponse.json(
			{ error: "rate limit (5 destructive actions/hour)" },
			{ status: 429 },
		);
	}
	if (!metric || !isAllowedMetric(metric)) {
		audit({ ...baseAudit, result: "denied", reason: "metric_not_allowed" });
		return NextResponse.json({ error: `metric "${metric}" is not allowed` }, { status: 400 });
	}
	if (!startTime || !endTime) {
		audit({ ...baseAudit, result: "denied", reason: "missing_range" });
		return NextResponse.json({ error: "startTime and endTime required" }, { status: 400 });
	}

	let range;
	try {
		range = validateRange(startTime, endTime);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "range invalid";
		audit({ ...baseAudit, result: "denied", reason: msg });
		return NextResponse.json({ error: msg }, { status: 400 });
	}
	baseAudit.start_ts = range.startTs;
	baseAudit.end_ts = range.endTs;

	let pairs;
	try {
		pairs = parseLabels(labels ?? "");
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "labels invalid";
		audit({ ...baseAudit, result: "denied", reason: msg });
		return NextResponse.json({ error: msg }, { status: 400 });
	}

	const matcher = buildMatcher(metric, pairs);

	// Threshold-based "smart range" delete: find sample points above the
	// threshold inside the range, group them into spikes (>120s gap = new
	// spike), and delete each spike window (-30/+30s margin). This is the
	// behavior the original delete-ui shipped — kept here under the same
	// allowlist + rate-limit + audit guardrails.
	if (threshold != null && thresholdOp) {
		if (!/^(>|<|>=|<=|==|!=)$/.test(thresholdOp)) {
			audit({ ...baseAudit, result: "denied", reason: "bad_thresholdOp" });
			return NextResponse.json({ error: "thresholdOp invalid" }, { status: 400 });
		}
		const t = Number(threshold);
		if (!Number.isFinite(t)) {
			audit({ ...baseAudit, result: "denied", reason: "bad_threshold" });
			return NextResponse.json({ error: "threshold must be a number" }, { status: 400 });
		}
		const q = `${matcher} ${thresholdOp} ${t}`;
		const qURL = `/api/v1/query_range?query=${encodeURIComponent(q)}&start=${range.startTs}&end=${range.endTs}&step=15`;
		const qRes = await promRead(qURL);
		const qJSON = (await qRes.json()) as {
			data?: { result?: Array<{ values: Array<[number, string]> }> };
		};
		const spikes: Array<{ start: number; end: number }> = [];
		for (const s of qJSON.data?.result ?? []) {
			let spikeStart: number | null = null;
			let lastTs: number | null = null;
			for (const [ts] of s.values) {
				if (spikeStart === null) {
					spikeStart = ts;
					lastTs = ts;
				} else if (lastTs && ts - lastTs > 120) {
					spikes.push({ start: spikeStart - 30, end: lastTs + 30 });
					spikeStart = ts;
				}
				lastTs = ts;
			}
			if (spikeStart != null && lastTs != null) {
				spikes.push({ start: spikeStart - 30, end: lastTs + 30 });
			}
		}
		let deleted = 0;
		for (const sp of spikes) {
			const p = new URLSearchParams();
			p.set("match[]", matcher);
			p.set("start", String(Math.floor(sp.start)));
			p.set("end", String(Math.ceil(sp.end)));
			const r = await promAdmin(`/api/v1/admin/tsdb/delete_series?${p.toString()}`, {
				method: "POST",
			});
			if (r.status === 204) deleted++;
		}
		await promAdmin("/api/v1/admin/tsdb/clean_tombstones", { method: "POST" });
		audit({
			...baseAudit,
			groups: spikes.length,
			result: "ok",
			reason: `threshold ${thresholdOp} ${threshold}`,
		});
		return NextResponse.json({
			message: `Deleted ${deleted} spike(s) (over ${spikes.length} detected) from ${metric}`,
			deleted,
			groups: spikes.length,
			request_id: requestId,
		});
	}

	// Normal whole-range delete with ±60s margin (matches original behavior).
	const expandedStart = range.startTs - 60;
	const expandedEnd = range.endTs + 60;
	const params = new URLSearchParams();
	params.set("match[]", matcher);
	params.set("start", String(expandedStart));
	params.set("end", String(expandedEnd));

	const delRes = await promAdmin(`/api/v1/admin/tsdb/delete_series?${params.toString()}`, {
		method: "POST",
	});
	if (delRes.status !== 204) {
		const text = await delRes.text();
		audit({
			...baseAudit,
			result: "error",
			reason: `delete_series http_${delRes.status}`,
		});
		return NextResponse.json(
			{ error: `delete_series failed: ${delRes.status}`, body: text.slice(0, 500) },
			{ status: 502 },
		);
	}
	const cleanRes = await promAdmin("/api/v1/admin/tsdb/clean_tombstones", { method: "POST" });
	const cleanOk = cleanRes.status === 204;

	audit({ ...baseAudit, result: "ok" });
	return NextResponse.json({
		message: `Successfully deleted ${metric} from ${new Date(startTime).toLocaleString()} to ${new Date(endTime).toLocaleString()}`,
		matcher,
		clean_tombstones: cleanOk,
		request_id: requestId,
	});
}
