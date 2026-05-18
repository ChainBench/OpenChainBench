import type { ProviderType } from "@/types/benchmark";

const LABELS: Record<ProviderType, string> = {
  protocol: "Protocol",
  aggregator: "Aggregator",
  intent: "Intent",
  relay: "Relay",
};

const HINTS: Record<ProviderType, string> = {
  protocol:
    "Direct protocol: returns its own quote / charges its own fee. Apples-to-apples with other protocols.",
  aggregator:
    "Aggregator: queries N underlying providers and surfaces the best route. Latency / fee figures include aggregation overhead.",
  intent:
    "Intent layer: settlement bakes the multi-provider query into one signed intent.",
  relay:
    "Relay / settlement network: operates its own relayer infrastructure.",
};

/**
 * Small monospace badge rendered next to a provider name on benchmark
 * pages and share-cards. The point is editorial transparency: when an
 * aggregator (LiFi) sits next to a single protocol (Debridge) in the
 * ledger, readers can see at a glance that the comparison isn't
 * structurally apples-to-apples.
 */
export function ProviderTypeBadge({ type }: { type: ProviderType }) {
  return (
    <span
      title={HINTS[type]}
      className="font-sans text-[9px] uppercase tracking-[0.14em] font-medium px-1.5 py-[1px] rounded-sm border border-rule text-ink-faint bg-paper-soft/40"
    >
      {LABELS[type]}
    </span>
  );
}
