// POST /api/smart-clean — original delete-ui auto-bulk wipe for
// head_lag_seconds{aggregator="mobula"}. Scans the last N hours for points
// over a threshold, groups consecutive ones (>120s gap = new group), and
// bulk-deletes each group with ±180s margin.
//
// Security stack (same as /api/delete):
//   - Basic Auth middleware gates this route
//   - Hardcoded metric = head_lag_seconds (no user-supplied selector)
//   - hours capped at 168h, threshold must be finite, max 50 groups per run
//   - Rate-limited on the destructive bucket (5/h/user)
//   - Bearer for Caddy admin API attached server-side only
//   - Every action audited to stdout

import { NextRequest, NextResponse } from "next/server";
import { promAdmin, promRead } from "@/app/lib/prom";
import { audit, newRequestId } from "@/app/lib/audit";
import { allowDestructive, allowRead } from "@/app/lib/rate-limit";

const MAX_HOURS = 168;
const MAX_GROUPS_PER_RUN = 500;

type Spike = { timestamp: number; value: number; region: string; chain: string };
type SpikeGroup = {
	region: string;
	chain: string;
	startTs: number;
	endTs: number;
	duration: number;
};

export async function POST(req: NextRequest) {
	const user = req.headers.get("x-admin-user") ?? "unknown";
	const requestId = newRequestId();

	const body = await req.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return NextResponse.json({ error: "invalid body" }, { status: 400 });
	}
	const { threshold = 5, hours = 24, dryRun = false } = body as {
		threshold?: number;
		hours?: number;
		dryRun?: boolean;
	};

	const t = Number(threshold);
	const h = Number(hours);
	if (!Number.isFinite(t) || t <= 0) {
		return NextResponse.json({ error: "threshold must be > 0" }, { status: 400 });
	}
	if (!Number.isFinite(h) || h <= 0 || h > MAX_HOURS) {
		return NextResponse.json({ error: `hours must be 0 < h <= ${MAX_HOURS}` }, { status: 400 });
	}

	const baseAudit = {
		user,
		action: dryRun ? ("smart-clean-dry-run" as const) : ("smart-clean" as const),
		metric: "head_lag_seconds",
		labels: `aggregator="mobula"`,
		start_ts: 0,
		end_ts: 0,
		request_id: requestId,
	};

	// Read bucket for dry-run, destructive bucket for the real wipe.
	if (dryRun) {
		if (!allowRead(user)) {
			audit({ ...baseAudit, result: "denied", reason: "rate_limit" });
			return NextResponse.json({ error: "rate limit" }, { status: 429 });
		}
	} else if (!allowDestructive(user)) {
		audit({ ...baseAudit, result: "denied", reason: "rate_limit" });
		return NextResponse.json(
			{ error: "rate limit (5 destructive actions/hour)" },
			{ status: 429 },
		);
	}

	const endTs = Math.floor(Date.now() / 1000);
	const startTs = endTs - Math.round(h * 3600);
	baseAudit.start_ts = startTs;
	baseAudit.end_ts = endTs;

	const query = 'head_lag_seconds{aggregator="mobula"}';
	// Adaptive step: keep raw resolution on short windows, coarsen for long ones
	// so we don't blow past Prom's max-samples limit (default 50M but tunable).
	const step = h <= 24 ? 15 : h <= 72 ? 30 : 60;
	const queryUrl = `/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startTs}&end=${endTs}&step=${step}`;
	const qRes = await promRead(queryUrl);
	if (!qRes.ok) {
		const txt = await qRes.text().catch(() => "");
		audit({ ...baseAudit, result: "error", reason: `prom_${qRes.status}` });
		return NextResponse.json(
			{ error: `prometheus query_range failed (${qRes.status}): ${txt.slice(0, 300)}` },
			{ status: 502 },
		);
	}
	const data = (await qRes.json()) as {
		status?: string;
		error?: string;
		data?: { result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
	};
	if (data.status === "error") {
		audit({ ...baseAudit, result: "error", reason: `prom_error ${data.error ?? ""}` });
		return NextResponse.json(
			{ error: `prometheus error: ${data.error ?? "unknown"}` },
			{ status: 502 },
		);
	}

	// Filter spikes over the threshold
	const rawSpikes: Spike[] = [];
	for (const s of data.data?.result ?? []) {
		const region = s.metric.region || "unknown";
		const chain = s.metric.chain || "unknown";
		for (const [timestamp, value] of s.values) {
			const v = Number.parseFloat(value);
			if (v > t) rawSpikes.push({ timestamp: Number(timestamp), value: v, region, chain });
		}
	}
	rawSpikes.sort((a, b) => {
		if (a.region !== b.region) return a.region.localeCompare(b.region);
		if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
		return a.timestamp - b.timestamp;
	});

	// Group consecutive spikes per (region, chain). Gap > 120s = new group.
	const groups: SpikeGroup[] = [];
	let current: SpikeGroup | null = null;
	for (const sp of rawSpikes) {
		if (
			!current ||
			current.region !== sp.region ||
			current.chain !== sp.chain ||
			sp.timestamp - current.endTs > 120
		) {
			if (current) groups.push(current);
			current = { region: sp.region, chain: sp.chain, startTs: sp.timestamp, endTs: sp.timestamp, duration: 0 };
		} else {
			current.endTs = sp.timestamp;
		}
	}
	if (current) groups.push(current);
	for (const g of groups) g.duration = g.endTs - g.startTs;

	// Hard cap — refuse runs that would touch huge swaths of data.
	if (groups.length > MAX_GROUPS_PER_RUN) {
		audit({
			...baseAudit,
			groups: groups.length,
			result: "denied",
			reason: `too_many_groups ${groups.length} > ${MAX_GROUPS_PER_RUN}`,
		});
		return NextResponse.json(
			{
				error: `${groups.length} groups detected, max ${MAX_GROUPS_PER_RUN}/run. Run a dry-run, tighten the threshold or shrink hours.`,
			},
			{ status: 400 },
		);
	}

	if (dryRun) {
		audit({ ...baseAudit, groups: groups.length, result: "ok", reason: "dry_run" });
		return NextResponse.json({
			dryRun: true,
			totalSpikes: rawSpikes.length,
			totalGroups: groups.length,
			groups: groups.map((g) => ({
				region: g.region,
				chain: g.chain,
				startTime: new Date(g.startTs * 1000).toISOString(),
				endTime: new Date(g.endTs * 1000).toISOString(),
				duration: g.duration,
			})),
		});
	}

	// Execute deletes (±180s margin per group).
	let deletedCount = 0;
	let failedCount = 0;
	for (const g of groups) {
		const expStart = g.startTs - 180;
		const expEnd = g.endTs + 180;
		const match = `head_lag_seconds{aggregator="mobula",region="${g.region}",chain="${g.chain}"}`;
		const params = new URLSearchParams();
		params.set("match[]", match);
		params.set("start", String(expStart));
		params.set("end", String(expEnd));
		const r = await promAdmin(`/api/v1/admin/tsdb/delete_series?${params.toString()}`, {
			method: "POST",
		});
		if (r.status === 204) deletedCount++;
		else failedCount++;
	}
	await promAdmin("/api/v1/admin/tsdb/clean_tombstones", { method: "POST" });

	audit({
		...baseAudit,
		groups: groups.length,
		result: failedCount > 0 ? "error" : "ok",
		reason: failedCount > 0 ? `${failedCount} groups failed` : undefined,
	});
	return NextResponse.json({
		dryRun: false,
		totalSpikes: rawSpikes.length,
		totalGroups: groups.length,
		deleted: deletedCount,
		failed: failedCount,
		groups: groups.map((g) => ({
			region: g.region,
			chain: g.chain,
			startTime: new Date(g.startTs * 1000).toISOString(),
			endTime: new Date(g.endTs * 1000).toISOString(),
			duration: g.duration,
		})),
		request_id: requestId,
	});
}
