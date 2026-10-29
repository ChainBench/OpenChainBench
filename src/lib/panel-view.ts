/**
 * Which metric panels a reader may select as the board's active view.
 *
 * This exists because the rule lived in two places that disagreed. A panel
 * declaring `tab: false` is data-only by the type's own definition: it feeds
 * ledger column window variants and renders no chart tab. But the `?view=`
 * seed validated only that the id existed, so a data-only panel could still
 * become the active view through a URL.
 *
 * That matters more than a cosmetic inconsistency. In the panel view the
 * board switches to one value per row through pickValue, which coerces a
 * provider with no reading to 0 (ledger-table.tsx:222). On the RPC API
 * coverage bench that published "this provider declines tracing" for a
 * provider whose key we are refused on and never asked. The ledger columns
 * render the same absence correctly as a dash, so the fault was invisible on
 * the default board and reachable only by URL.
 *
 * The coercion in pickValue is not wrong everywhere: on a latency bench every
 * ranked provider has a value and a 0 is not a claim about anyone. It
 * misleads only where absence is meaningful, which is why the fix is to
 * honour the flag that already says "this panel is not a view" rather than to
 * change how every bench renders.
 */
export function isSelectablePanelView(panel: { tab?: boolean }): boolean {
  return panel.tab !== false;
}

/**
 * Resolve a `?view=` parameter against the panels a bench actually publishes.
 *
 * Returns null for an id that does not exist (a panel dropped from the spec
 * between deploys) and for one that exists but is data-only, so a stale or
 * hand-written URL falls back to the default board instead of pinning a view
 * that would invent values.
 */
export function resolvePanelView<T extends { id: string; tab?: boolean }>(
  urlView: string | null,
  panels: readonly T[],
): string | null {
  if (!urlView) return null;
  return panels.some((p) => p.id === urlView && isSelectablePanelView(p))
    ? urlView
    : null;
}
