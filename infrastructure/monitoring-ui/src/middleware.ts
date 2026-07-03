import { NextResponse, type NextRequest } from "next/server";

const REALM = 'Basic realm="OpenBench monitoring", charset="UTF-8"';

export function middleware(req: NextRequest) {
  const expected = process.env.ADMIN_BASIC_AUTH;
  if (!expected) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header) {
    const [scheme, value] = header.split(" ");
    if (scheme === "Basic" && value) {
      const decoded = Buffer.from(value, "base64").toString("utf-8");
      if (decoded === expected) return NextResponse.next();
    }
  }
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": REALM },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
