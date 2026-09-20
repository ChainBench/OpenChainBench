import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, isValidSession } from "@/lib/auth";

// Everything except the login page and its POST needs the session cookie.
// Static assets are excluded by the matcher.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // /api/ingest/* is authenticated by the sender's signature (see the route).
  if (pathname === "/login" || pathname === "/api/login" || pathname.startsWith("/api/ingest/")) return NextResponse.next();
  const ok = await isValidSession(request.cookies.get(COOKIE)?.value);
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
