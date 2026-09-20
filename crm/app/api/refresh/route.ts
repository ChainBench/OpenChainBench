import type { NextRequest } from "next/server";
import { seeOther } from "@/lib/auth";
import { MANUAL_COOLDOWN_MINUTES, readSnapshot, refreshSnapshot, snapshotAgeMinutes } from "@/lib/snapshot";

// Manual refresh, behind the session cookie (proxy.ts) and a cooldown: the
// button cannot become a way to spend the PostHog budget.
export async function POST(request: NextRequest) {
  const snap = await readSnapshot();
  const age = snapshotAgeMinutes(snap);
  // Back to the page the button was on; only the path of the referer is kept.
  let back = "/";
  try {
    const ref = new URL(request.headers.get("referer") ?? "", "http://x");
    back = ref.pathname.startsWith("/") ? ref.pathname : "/";
  } catch {
    // fall through to the overview
  }
  if (age != null && age < MANUAL_COOLDOWN_MINUTES) {
    return seeOther(request, `${back}?refresh=cooldown:${Math.ceil(MANUAL_COOLDOWN_MINUTES - age)}`);
  }
  const result = await refreshSnapshot("manual");
  const flag = result.joined ? "joined" : result.stoppedBy ? "partial" : result.failed.length ? "errors" : "ok";
  return seeOther(request, `${back}?refresh=${flag}`);
}
