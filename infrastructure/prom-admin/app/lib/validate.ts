// Input validation + selector sanitization.
//
// The original delete-ui interpolated `labels` raw into PromQL — selector
// injection vector (`labels="foo=bar} or __name__=~\".+\""` would wipe
// everything). Here we PARSE the labels as `key="value"` pairs into a typed
// shape and re-serialize from the parsed form, so anything that doesn't fit
// the schema is rejected.

// Hard caps. A single delete that wipes >7 days or covers >1000 series is
// almost certainly a mistake. The harness emits ~17k series/day, so 1000 is
// roughly 1.5h of one bench's full output.
export const MAX_RANGE_HOURS = 168; // 7 days
export const MAX_AGE_DAYS = 90; // can't delete data older than this
export const MAX_SERIES_PER_DELETE = 5000;

// Metric allowlist. Only metrics in this prefix family are wipe-eligible.
// Add more names here, NOT in the user-facing form, when needed.
// Keeping this server-side prevents the UI from passing arbitrary metric
// names — even with a compromised browser bundle.
export const ALLOWED_METRIC_PREFIXES = [
	"head_lag_",
	"l1_finality_",
	"l2_block_time_",
	"solana_quote_",
	"solana_landing_",
	"bridge_quote_",
	"bridge_cost_",
	"bridge_fee_",
	"relay_revenue",
	"relay_take_",
	"relay_volume_",
	"relay_swap_",
	"metadata_coverage_",
	"networks_supported_total",
	"rpc_latency_",
	"rpc_call_total",
	"rpc_archive_",
	"rpc_health",
	"gas_oracle_",
	"peg_",
	"perp_fees_",
	"ocb_buyback_",
	"ocb_oracle_",
	"ocb_chain_",
	"hl_frontend_",
	"wallet_labels_",
];

export function isAllowedMetric(name: string): boolean {
	if (typeof name !== "string" || name.length === 0 || name.length > 100) return false;
	if (!/^[a-z][a-z0-9_]*$/.test(name)) return false;
	return ALLOWED_METRIC_PREFIXES.some(
		(p) => name === p || name.startsWith(p) || name === p.replace(/_$/, ""),
	);
}

export type LabelPair = { key: string; value: string };

// parseLabels accepts the freeform input from the UI in PromQL-style
// `key="value", key2="value2"` and turns it into a strict array of typed
// pairs. Anything that doesn't match is rejected — no parsing-tolerance.
// Keys: ^[a-zA-Z_][a-zA-Z0-9_]*$
// Values: any printable, no `"` or `\`, max 200 chars.
export function parseLabels(input: string): LabelPair[] {
	if (!input || input.trim() === "") return [];
	const trimmed = input.trim();
	if (trimmed.length > 1000) {
		throw new Error("labels string too long");
	}
	const pairs: LabelPair[] = [];
	const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"\\]{0,200})"\s*,?\s*/g;
	let lastEnd = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(trimmed)) !== null) {
		if (m.index !== lastEnd) {
			throw new Error(`labels: unexpected content at position ${lastEnd}`);
		}
		pairs.push({ key: m[1], value: m[2] });
		lastEnd = re.lastIndex;
	}
	if (lastEnd !== trimmed.length) {
		throw new Error(`labels: unparsed remainder at position ${lastEnd}`);
	}
	if (pairs.length === 0) {
		throw new Error("labels: no pairs parsed (expected key=\"value\")");
	}
	if (pairs.length > 10) {
		throw new Error("labels: too many pairs (max 10)");
	}
	// Reject duplicate keys.
	const seen = new Set<string>();
	for (const p of pairs) {
		if (seen.has(p.key)) {
			throw new Error(`labels: duplicate key "${p.key}"`);
		}
		seen.add(p.key);
	}
	return pairs;
}

// Serialize back to PromQL safe form. Each value re-escaped (we already know
// it has no `"` or `\` after parse). Order is preserved.
export function serializeLabels(pairs: LabelPair[]): string {
	return pairs.map((p) => `${p.key}="${p.value}"`).join(",");
}

export type ValidatedRange = { startTs: number; endTs: number };

export function validateRange(startTimeIso: string, endTimeIso: string): ValidatedRange {
	const startTs = Math.floor(new Date(startTimeIso).getTime() / 1000);
	const endTs = Math.floor(new Date(endTimeIso).getTime() / 1000);
	if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
		throw new Error("range: invalid datetime");
	}
	if (endTs <= startTs) {
		throw new Error("range: end must be after start");
	}
	const hours = (endTs - startTs) / 3600;
	if (hours > MAX_RANGE_HOURS) {
		throw new Error(`range: window too wide (${hours.toFixed(1)}h, max ${MAX_RANGE_HOURS}h)`);
	}
	const now = Math.floor(Date.now() / 1000);
	const ageDays = (now - startTs) / 86400;
	if (ageDays > MAX_AGE_DAYS) {
		throw new Error(`range: start too far in the past (${ageDays.toFixed(0)}d, max ${MAX_AGE_DAYS}d)`);
	}
	if (endTs > now + 60) {
		throw new Error("range: end in the future");
	}
	return { startTs, endTs };
}

// buildMatcher builds the PromQL selector for delete_series / query.
// metric must be allowed (caller's job). labels are parsed pairs.
export function buildMatcher(metric: string, pairs: LabelPair[]): string {
	if (pairs.length === 0) return metric;
	return `${metric}{${serializeLabels(pairs)}}`;
}

// confirmTokenFor returns the typed-slug confirmation string the UI must
// re-type to enable a destructive action. Format pins the metric + the start
// timestamp so a careless copy-paste from a different prepared action fails.
export function confirmTokenFor(metric: string, startTs: number): string {
	return `delete-${metric}-${startTs}`;
}
