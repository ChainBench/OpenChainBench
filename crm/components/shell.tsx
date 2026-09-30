import Link from "next/link";
import { MANUAL_COOLDOWN_MINUTES, REFRESH_MINUTES, snapshotAgeMinutes, type Snapshot } from "@/lib/snapshot";
import { WINDOW_KEYS, WINDOWS, withWindow, type ReportWindow } from "@/lib/window";

const NAV = [
  ["/", "Overview"],
  ["/pages", "Pages"],
  ["/audience", "Audience"],
  ["/actions", "Actions"],
  ["/health", "Data health"],
] as const;

export function fmtAge(min: number | null): string {
  if (min == null) return "never";
  if (min < 1) return "just now";
  if (min < 90) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

export function Shell({ current, snapshot, refreshFlag, window: w, children }: { current: string; snapshot: Snapshot; refreshFlag?: string; window: ReportWindow; children: React.ReactNode }) {
  const age = snapshotAgeMinutes(snapshot);
  const errors = Object.entries(snapshot.status).filter(([, s]) => s.error);
  const canRefresh = age == null || age >= MANUAL_COOLDOWN_MINUTES;
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-5">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <Link href="/" className="mono text-base font-semibold tracking-tight">
          OCB <span style={{ color: "var(--accent)" }}>CRM</span>
        </Link>
        <nav className="flex flex-wrap gap-1 text-[13px]">
          {NAV.map(([href, label]) => (
            <Link key={href} href={withWindow(href, w)} className="nav" aria-current={current === href ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: "var(--muted)" }}>
          {/* Every windowed figure on the dashboard follows this, and the
              refresh stores both windows, so switching costs no query. */}
          <div className="flex rounded-md border" style={{ borderColor: "var(--line)" }} role="group" aria-label="Reporting window">
            {WINDOW_KEYS.map((k) => (
              <Link
                key={k}
                href={withWindow(current, WINDOWS[k])}
                aria-current={w.key === k ? "true" : undefined}
                className="px-2.5 py-1 text-xs first:rounded-l-md last:rounded-r-md"
                style={w.key === k ? { background: "var(--line)", color: "var(--fg)" } : undefined}
                title={k === "24h" ? "Today against yesterday" : "The last 7 days against the 7 before"}
              >
                {WINDOWS[k].label}
              </Link>
            ))}
          </div>
          <span title={snapshot.refreshedAt ?? ""}>
            Snapshot {fmtAge(age)}
            {age != null && age < REFRESH_MINUTES ? ` · next in ${Math.max(1, Math.round(REFRESH_MINUTES - age))} min` : ` · refreshes every ${REFRESH_MINUTES} min`}
            {" "}· PostHog {snapshot.budget.used}/{snapshot.budget.limit} queries per hour
          </span>
          <form action={withWindow("/api/refresh", w)} method="post">
            <button
              type="submit"
              disabled={!canRefresh}
              className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
              style={{ borderColor: "var(--line)" }}
              title={canRefresh ? "Run every loader now" : `Available ${MANUAL_COOLDOWN_MINUTES} min after the last refresh`}
            >
              Refresh
            </button>
          </form>
          <form action="/api/logout" method="post">
            <button type="submit" className="text-xs underline-offset-2 hover:underline">
              Log out
            </button>
          </form>
        </div>
      </header>
      {refreshFlag && (
        <p className="panel mb-4 px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
          {refreshFlag === "ok" && "Refreshed."}
          {refreshFlag === "joined" && "A refresh was already running; this is its result."}
          {refreshFlag === "errors" && "Refreshed; some sections failed and kept their previous values (see below)."}
          {refreshFlag === "partial" && "Refresh stopped early (PostHog rate limit or local budget); the remaining sections kept their previous values."}
          {refreshFlag.startsWith("cooldown:") && `Last refresh is too recent; try again in ${refreshFlag.split(":")[1]} min.`}
        </p>
      )}
      {!snapshot.posthogConfigured && (
        <p className="panel mb-4 px-3 py-2 text-xs" style={{ color: "var(--warn)" }}>
          PostHog is not configured on this deployment (POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID). Traffic sections are empty; data health still works.
        </p>
      )}
      {errors.length > 0 && (
        <details className="panel mb-4 px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
          <summary style={{ color: "var(--warn)" }}>
            {errors.length} section{errors.length > 1 ? "s" : ""} failed on the last refresh (previous values shown)
          </summary>
          <ul className="mono mt-2 space-y-1">
            {errors.map(([k, s]) => (
              <li key={k}>
                {k}: {s.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {children}
    </div>
  );
}
