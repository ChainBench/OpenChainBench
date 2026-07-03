// Helpers to talk to the OCB Prometheus.
//
// READ queries hit the gateway with NO bearer (publicly readable — Vercel
// reads the same paths). ADMIN endpoints (`/admin/tsdb/*`, `/-/reload`, etc.)
// require the bearer the Caddy gateway expects.

const READ_TIMEOUT_MS = 15_000;
const ADMIN_TIMEOUT_MS = 30_000;

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || v.trim() === "") {
		throw new Error(`missing env: ${name}`);
	}
	return v;
}

export function promGatewayUrl(): string {
	return requireEnv("PROM_GATEWAY_URL");
}

function adminToken(): string {
	return requireEnv("PROM_ADMIN_TOKEN");
}

export async function promRead(path: string, init?: RequestInit): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
	try {
		return await fetch(`${promGatewayUrl()}${path}`, {
			...init,
			signal: ctrl.signal,
			cache: "no-store",
		});
	} finally {
		clearTimeout(t);
	}
}

export async function promAdmin(path: string, init?: RequestInit): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ADMIN_TIMEOUT_MS);
	try {
		const headers = new Headers(init?.headers);
		headers.set("X-Admin-Token", adminToken());
		return await fetch(`${promGatewayUrl()}${path}`, {
			...init,
			headers,
			signal: ctrl.signal,
			cache: "no-store",
		});
	} finally {
		clearTimeout(t);
	}
}
