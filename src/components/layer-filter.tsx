"use client";

/**
 * Three-pill filter (All / L1 / L2) shown above the ledger table on
 * benches that mix L1 and L2 providers (currently only `network-fees`).
 *
 * Pure presentation: holds no state. The parent (benchmark-body) owns
 * the active layer and passes it down with the swap callback. The
 * parent also decides whether to render this at all — when no provider
 * carries a `layer` field, the filter stays hidden.
 */
export type LayerSelection = "all" | "l1" | "l2";

export function LayerFilter({
  selected,
  onSelect,
  counts,
}: {
  selected: LayerSelection;
  onSelect: (v: LayerSelection) => void;
  counts: { all: number; l1: number; l2: number };
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1">
      <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        Layer
      </span>
      <Pill label="All" count={counts.all} active={selected === "all"} onClick={() => onSelect("all")} />
      <Pill label="L1" count={counts.l1} active={selected === "l1"} onClick={() => onSelect("l1")} />
      <Pill label="L2" count={counts.l2} active={selected === "l2"} onClick={() => onSelect("l2")} />
    </div>
  );
}

function Pill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
        active
          ? "bg-ink text-paper"
          : "text-ink-muted hover:text-ink",
      ].join(" ")}
    >
      {label}
      <span className={["ml-1.5 text-[10px]", active ? "text-paper/70" : "text-ink-faint"].join(" ")}>
        {count}
      </span>
    </button>
  );
}
