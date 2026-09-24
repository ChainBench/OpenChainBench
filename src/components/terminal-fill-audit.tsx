import { TerminalFillSwaps } from "@/components/terminal-fill-swaps";
import { getTerminalFills } from "@/lib/terminal-fills";

/**
 * Audit table of bench 268 on its own bench page: every sampled swap of
 * the rolling window (last 400), one real transaction per row with its
 * Solscan link, side, venue and route, size, loss and cost split,
 * reference source and sandwich screen. Always open, so the figures in
 * the ledger above can be checked transaction by transaction.
 *
 * Server component reading the harness JSON (5 min revalidate); renders
 * nothing when the JSON is unavailable.
 */
export async function TerminalFillAudit() {
  const f = await getTerminalFills();
  if (!f || f.recent.length === 0) return null;
  const priced = f.recent.filter((s) => s.priced).length;
  return (
    <div id="swaps" className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8 scroll-mt-24">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="label-mono text-ink-faint">Sampled swaps · audit table</p>
          <p className="mt-1 text-sm text-ink-faint max-w-3xl">
            The most recent transactions of <em>each</em> row ({f.recent.length} in all, {priced} priced), so every published figure has
            its own evidence here. These are a sample, not the statistic: the medians above are computed over the full rolling window,
            which is far more swaps than a row shows here, so a row&apos;s handful of transactions will not reproduce its median. Click a
            hash to open it on Solscan and check every figure against the transaction&apos;s balances: Loss = 1 − value received / value
            given; Fee + Net + Protocol + Pool (+ Relay on the cross-chain rows) = Loss. Ref says what the tokens were valued at
            (reserves: the pool&apos;s exact mid before the swap; pool: the previous trade on the same pool, age in seconds). A{" "}
            <span className="font-mono">!</span> marks a row outside the plausible bounds, kept out of the statistics.
          </p>
        </div>
        <p className="text-xs text-ink-faint whitespace-nowrap">
          method v{f.methodVersion} · as of {f.generatedAt ? new Date(f.generatedAt).toUTCString().replace("GMT", "UTC") : "—"}
        </p>
      </div>
      <div className="mt-6">
        <TerminalFillSwaps swaps={f.recent} terminals={f.terminals.map((t) => ({ slug: t.slug, name: t.name }))} />
      </div>
    </div>
  );
}
