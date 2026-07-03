// Audit log.
//
// v1 = append-only JSONL to stdout (Railway captures all stdout, queryable
// via Datadog later). Every destructive action MUST call audit() before
// returning.
//
// Each entry has user (from middleware), action, metric, labels, range,
// series_count (when known), result, request_id. Fields are flat for easy
// log parsing.

export type AuditEvent = {
	ts: string; // ISO8601
	user: string; // from middleware
	action: "preview" | "delete" | "smart-clean" | "smart-clean-dry-run";
	metric: string;
	labels: string;
	start_ts: number;
	end_ts: number;
	series_count?: number;
	groups?: number;
	result: "ok" | "denied" | "error";
	reason?: string; // present on denied / error
	request_id: string;
};

export function audit(ev: Omit<AuditEvent, "ts">) {
	const full: AuditEvent = { ts: new Date().toISOString(), ...ev };
	// Single-line JSON, prefixed with [AUDIT] so it's grep-friendly in Railway logs.
	console.log(`[AUDIT] ${JSON.stringify(full)}`);
}

export function newRequestId(): string {
	// 8 random hex chars — collision unlikely at the volume this thing sees.
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
