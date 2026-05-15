"use client";

import { CHAIN_LIST } from "@/lib/live/chains";

/**
 * Top-of-page chain filter pills row. "All chains" is the default active
 * state — clicking a chain hides every other chain in the live stream
 * via the existing `hiddenChains` Set. Mirrors the design's pill chrome
 * (`.pill` + accent active state) while reusing the live stream's
 * single-chain-visibility model.
 */
export function ChainFilter({
  hiddenChains,
  onSetHidden,
}: {
  hiddenChains: Set<string>;
  onSetHidden: (next: Set<string>) => void;
}) {
  const allKeys = CHAIN_LIST.map((c) => c.key);
  const visibleCount = allKeys.filter((k) => !hiddenChains.has(k)).length;
  const allVisible = visibleCount === allKeys.length;

  function activateAll() {
    onSetHidden(new Set());
  }

  function activateOne(key: string) {
    // Hide every other chain so only the picked one shows. Click the
    // already-active single chain to fall back to "All chains".
    if (!allVisible && !hiddenChains.has(key) && visibleCount === 1) {
      onSetHidden(new Set());
      return;
    }
    const next = new Set<string>();
    for (const k of allKeys) if (k !== key) next.add(k);
    onSetHidden(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={activateAll}
        className="pill"
        data-active={allVisible || undefined}
      >
        All chains
      </button>
      {CHAIN_LIST.map((c) => {
        const isSoloActive = !allVisible && !hiddenChains.has(c.key) && visibleCount === 1;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => activateOne(c.key)}
            className="pill"
            data-active={isSoloActive || undefined}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: c.color }}
              aria-hidden
            />
            {c.display}
          </button>
        );
      })}
    </div>
  );
}
