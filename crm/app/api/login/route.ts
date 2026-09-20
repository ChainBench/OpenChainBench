import type { NextRequest } from "next/server";
import { authConfigured, COOKIE, passwordMatches, seeOther, sessionToken } from "@/lib/auth";

// A small fixed delay per attempt; there is one password and no account to lock.
const ATTEMPT_DELAY_MS = 600;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const nextPath = String(form.get("next") ?? "/");
  await new Promise((r) => setTimeout(r, ATTEMPT_DELAY_MS));
  if (!authConfigured() || !(await passwordMatches(password))) {
    return seeOther(request, `/login?error=1${nextPath !== "/" ? `&next=${encodeURIComponent(nextPath)}` : ""}`);
  }
  const res = seeOther(request, nextPath);
  const token = await sessionToken();
  const attrs = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${60 * 60 * 24 * 30}`];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.headers.append("Set-Cookie", attrs.join("; "));
  return res;
}
