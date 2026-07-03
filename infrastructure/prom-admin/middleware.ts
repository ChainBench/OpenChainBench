// Edge middleware — gates EVERY admin route behind HTTP Basic Auth.
//
// This is Layer 2 of the auth stack:
//   Layer 1: Cloudflare Access (user identity, email allowlist)
//   Layer 2: this — HTTP Basic Auth (shared password, env-injected)
//   Layer 3: Caddy gateway in front of Prom (bearer token, server-side only)
//
// The 3 layers protect against different failure modes — see README.
//
// Defense-in-depth note: the Basic Auth secret here is NOT the same as the
// Caddy bearer. A leak of one does not grant access to the other.
import { NextRequest, NextResponse } from "next/server";

const REALM = 'OCB Prom Admin';

export function middleware(req: NextRequest) {
	// /health is intentionally unauthenticated so Railway's healthcheck works.
	if (req.nextUrl.pathname === "/health") {
		return NextResponse.next();
	}

	const expectedUser = process.env.ADMIN_USER ?? "";
	const expectedPass = process.env.ADMIN_PASS ?? "";

	if (!expectedUser || !expectedPass) {
		// Fail-closed: misconfiguration MUST block, not allow.
		return new NextResponse(
			"server misconfigured — ADMIN_USER / ADMIN_PASS env vars not set",
			{ status: 503 },
		);
	}

	const header = req.headers.get("authorization") ?? "";
	if (!header.startsWith("Basic ")) {
		return new NextResponse("auth required", {
			status: 401,
			headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
		});
	}

	let user = "";
	let pass = "";
	try {
		const decoded = atob(header.slice(6));
		const idx = decoded.indexOf(":");
		if (idx < 0) throw new Error("malformed");
		user = decoded.slice(0, idx);
		pass = decoded.slice(idx + 1);
	} catch {
		return new NextResponse("bad auth header", {
			status: 401,
			headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
		});
	}

	// Constant-time-ish comparison via length-then-byte-loop. Edge runtime has
	// no `crypto.timingSafeEqual`, so we DIY.
	if (!safeEq(user, expectedUser) || !safeEq(pass, expectedPass)) {
		return new NextResponse("invalid credentials", {
			status: 401,
			headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
		});
	}

	// Pass the authenticated user down to route handlers via a custom header so
	// audit log can attribute actions.
	const res = NextResponse.next();
	res.headers.set("x-admin-user", user);
	return res;
}

function safeEq(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico|health).*)"],
};
