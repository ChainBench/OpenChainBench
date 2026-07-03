import { loadAllBenchRows, type BenchRow, type BenchStatus } from "@/lib/bench-state";
import { ActionButtons } from "@/components/action-buttons";
import { LogsButton } from "@/components/logs-modal";
import { benchPageUrl, diffUrl } from "@/lib/registry";

export const revalidate = 30;
export const dynamic = "force-dynamic";

const STATUS_INFO: Record<BenchStatus, { label: string; tip: string; cls: string }> = {
  synced: {
    label: "synced",
    tip: "Prod and staging have the exact same YAML. Nothing to do.",
    cls: "bg-emerald-900/40 text-emerald-300 border-emerald-700/50",
  },
  drift: {
    label: "drift",
    tip: "Both branches have the YAML but their contents differ (usually staging has changes not yet promoted to prod). Click → prod to push the staging version live.",
    cls: "bg-amber-900/40 text-amber-300 border-amber-700/50",
  },
  dev_only: {
    label: "staging only",
    tip: "Bench exists on staging (dev) only. Not visible on openchainbench.com. Click → prod to ship it.",
    cls: "bg-sky-900/40 text-sky-300 border-sky-700/50",
  },
  prod_only: {
    label: "prod only",
    tip: "Bench is on prod but not on staging. Unusual state — consider restoring the YAML on dev.",
    cls: "bg-fuchsia-900/40 text-fuchsia-300 border-fuchsia-700/50",
  },
  missing_everywhere: {
    label: "missing",
    tip: "No YAML on either branch.",
    cls: "bg-neutral-800 text-neutral-400 border-neutral-700",
  },
};

function StatusBadge({ status }: { status: BenchStatus }) {
  const m = STATUS_INFO[status];
  return (
    <span
      title={m.tip}
      className={`inline-block px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider cursor-help ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "short" });
}

function Cell({
  slot,
  href,
  emptyLabel,
}: {
  slot: BenchRow["main"];
  href: string;
  emptyLabel: string;
}) {
  if (!slot.state.exists) {
    return <span className="text-neutral-600 text-xs">{emptyLabel}</span>;
  }
  const c = slot.lastCommit;
  return (
    <div className="leading-tight">
      <a
        href={href}
        target="_blank"
        rel="noopener"
        title="Open bench page"
        className="text-emerald-400 text-xs hover:text-emerald-300 hover:underline inline-flex items-center gap-1"
      >
        ✓ {slot.state.sha.slice(0, 7)}
        <span className="text-[10px] text-neutral-500">↗</span>
      </a>
      {c && (
        <div className="text-[10px] text-neutral-500 mt-0.5">
          {c.sha} · {fmtDate(c.date)}
          <div className="truncate max-w-[18rem]" title={c.message}>
            {c.message}
          </div>
        </div>
      )}
    </div>
  );
}

function HarnessCell({ row }: { row: BenchRow }) {
  const h = row.entry.harness;
  if (h.type === "none") return <span className="text-neutral-600 text-xs">—</span>;
  if (h.type === "railway") {
    const total = 1 + (h.extraRegions?.length ?? 0);
    return (
      <div className="text-[10px]">
        <div className="text-cyan-400">railway{total > 1 ? ` ×${total}` : ""}</div>
        <div className="text-neutral-500 truncate max-w-[10rem]">{h.service}</div>
      </div>
    );
  }
  return (
    <div className="text-[10px]">
      <div className="text-purple-400">ovh</div>
      <div className="text-neutral-500 truncate max-w-[10rem]">{h.service}</div>
    </div>
  );
}

function SourceCell({ row }: { row: BenchRow }) {
  return (
    <a
      href={row.entry.sourceUrl}
      target="_blank"
      rel="noopener"
      title="Open harness / spec source on GitHub"
      className="text-[10px] text-neutral-400 hover:text-neutral-200 hover:underline inline-flex items-center gap-1"
    >
      source ↗
    </a>
  );
}

function LogsCell({ row }: { row: BenchRow }) {
  const h = row.entry.harness;
  if (h.type === "none") {
    return (
      <span
        title="No dedicated harness for this bench (data comes from elsewhere)"
        className="text-[10px] text-neutral-700 cursor-help"
      >
        —
      </span>
    );
  }
  return (
    <LogsButton
      slug={row.entry.slug}
      service={h.service}
      rawUrl={h.logsUrl}
      extraRegions={h.type === "railway" ? h.extraRegions : undefined}
    />
  );
}

export default async function HomePage() {
  const rows = await loadAllBenchRows();
  const counts = rows.reduce<Record<BenchStatus, number>>(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    { synced: 0, drift: 0, dev_only: 0, prod_only: 0, missing_everywhere: 0 },
  );

  return (
    <main className="px-6 py-8 max-w-[1600px] mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">OpenBench monitoring</h1>
        <p className="text-sm text-neutral-400 mt-1">
          Bench state on <code className="text-emerald-400">main</code> (prod = openchainbench.com)
          and <code className="text-sky-400">dev</code> (staging-openchainbench.vercel.app).
          Refreshed every 30s.
        </p>
        <div className="mt-3 flex gap-3 text-xs flex-wrap">
          <span className="text-emerald-400">✓ {counts.synced} synced</span>
          <span className="text-amber-400">⚠ {counts.drift} drift</span>
          <span className="text-sky-400">→ {counts.dev_only} staging only</span>
          <span className="text-fuchsia-400">← {counts.prod_only} prod only</span>
          {counts.missing_everywhere > 0 && (
            <span className="text-neutral-500">∅ {counts.missing_everywhere} missing</span>
          )}
        </div>
      </header>

      <details className="mb-6 text-xs text-neutral-400 border border-neutral-800 rounded px-4 py-3 bg-neutral-950">
        <summary className="cursor-pointer text-neutral-300 font-medium">
          How does it work?
        </summary>
        <div className="mt-3 space-y-2 leading-relaxed">
          <p>
            One row per bench. Left side shows its state on <code className="text-emerald-400">main</code> (prod = openchainbench.com),
            right side on <code className="text-sky-400">dev</code> (staging). Click the green SHA to open
            the bench page in the matching environment.
          </p>
          <p>
            <strong className="text-amber-300">DRIFT</strong>: both branches have the YAML but contents differ.
            Usually staging holds updates that haven't been promoted to prod yet.
          </p>
          <p>
            <strong className="text-sky-300">STAGING ONLY</strong>: bench exists on staging only.
            Invisible on openchainbench.com until you click <span className="text-emerald-400">→ prod</span>.
          </p>
          <p>
            <strong className="text-emerald-400">→ prod</strong>: copy the YAML from dev to main, open
            an auto-merged PR, and trigger a Vercel prod deploy. Confirmation modal where you must type
            <code> PROD</code> before execution.
          </p>
          <p>
            <strong className="text-rose-400">← remove</strong>: delete the YAML on main (kept on dev).
            Bench disappears from openchainbench.com after deploy but stays accessible on staging.
            Same confirmation modal.
          </p>
          <p>
            <strong className="text-neutral-300">Prod ETA ≈ 3-5 min</strong> after the click. The merged PR
            triggers the <code>prod-deploy.yml</code> GitHub Actions workflow that builds and deploys via
            the Vercel CLI. The result panel exposes a <em>follow CI deploy</em> link to watch the run live.
          </p>
          <p className="text-neutral-500">
            <code className="text-neutral-400">source</code> link: opens the harness or YAML source on GitHub.
            <code className="text-neutral-400 ml-2">logs</code> button: hits the harness <code>/logs</code>{" "}
            endpoint (X-Logs-Token auth) on the matching Railway / OVH service. Multi-region benches
            (aggregator-head-lag, rpc-capabilities, solana-dex-quote-latency) expose one button per region.
          </p>
        </div>
      </details>

      <div className="border border-neutral-800 rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-neutral-400 text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Bench</th>
              <th className="text-left px-3 py-2 font-medium">Prod (main)</th>
              <th className="text-left px-3 py-2 font-medium">Staging (dev)</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">Harness</th>
              <th className="text-left px-3 py-2 font-medium">Source</th>
              <th className="text-left px-3 py-2 font-medium">Logs</th>
              <th className="text-left px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.entry.slug} className="border-t border-neutral-800 hover:bg-neutral-900/40">
                <td className="px-3 py-3 align-top">
                  <div className="font-medium text-xs">{row.entry.slug}</div>
                  <div className="text-[10px] text-neutral-500 mt-0.5 max-w-[14rem]">
                    {row.entry.name}
                  </div>
                  {row.status === "drift" && (
                    <a
                      href={diffUrl(row.entry.slug)}
                      target="_blank"
                      rel="noopener"
                      className="text-[10px] text-amber-400 hover:underline mt-1 inline-block"
                    >
                      view diff ↗
                    </a>
                  )}
                </td>
                <td className="px-3 py-3 align-top">
                  <Cell
                    slot={row.main}
                    href={benchPageUrl("main", row.entry.slug)}
                    emptyLabel="absent (404 in prod)"
                  />
                </td>
                <td className="px-3 py-3 align-top">
                  <Cell
                    slot={row.dev}
                    href={benchPageUrl("dev", row.entry.slug)}
                    emptyLabel="absent (not on staging)"
                  />
                </td>
                <td className="px-3 py-3 align-top">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-3 py-3 align-top">
                  <HarnessCell row={row} />
                </td>
                <td className="px-3 py-3 align-top">
                  <SourceCell row={row} />
                </td>
                <td className="px-3 py-3 align-top">
                  <LogsCell row={row} />
                </td>
                <td className="px-3 py-3 align-top">
                  <ActionButtons slug={row.entry.slug} status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="mt-6 text-[11px] text-neutral-600">
        V1 promote / remove · next: harness ops (redeploy, logs, restart)
      </footer>
    </main>
  );
}
