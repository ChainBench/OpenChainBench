import type { NextRequest } from "next/server";
import { authConfigured, clientKey, COOKIE, issueSession, loginAllowed, passwordMatches, recordLoginAttempt, seeOther, SESSION_DAYS } from "@/lib/auth";

// A small fixed delay per attempt on top of the per-client limit.
const ATTEMPT_DELAY_MS = 600;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const nextPath = String(form.get("next") ?? "/");
  const back = (error: string) => seeOther(request, `/login?error=${error}${nextPath !== "/" ? `&next=${encodeURIComponent(nextPath)}` : ""}`);
  const key = clientKey(request);
  if (!loginAllowed(key)) return back("limited");
  recordLoginAttempt(key);
  await new Promise((r) => setTimeout(r, ATTEMPT_DELAY_MS));
  if (!authConfigured() || !(await passwordMatches(password))) return back("1");
  const res = seeOther(request, nextPath);
  const token = await issueSession();
  const attrs = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 86_400}`];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.headers.append("Set-Cookie", attrs.join("; "));
  return res;
}
