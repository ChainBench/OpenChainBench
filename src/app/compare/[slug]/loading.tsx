/**
 * Loading UI rendered by Next.js during navigation to /compare/[slug].
 * Picked up automatically when the route's async render is in flight,
 * which is the visible window where ad-hoc (non-curated) pairs pay the
 * full cold start cost: every loadBenchmark for every shared bench
 * fans out chain + region variant fetches. Without this file the user
 * sees a frozen current page while the browser waits on the route
 * payload; with it the visitor gets instant feedback that the compare
 * page is building.
 */
export default function ComparePairLoading() {
  return (
    <main className="mx-auto max-w-5xl px-6 pt-10 pb-16 sm:pt-14">
      <div className="h-4 w-48 bg-surface rounded animate-pulse" />

      <header className="mt-8 border-b-2 border-ink pb-6">
        <div className="h-10 w-3/4 bg-surface rounded animate-pulse" />
        <div className="mt-4 h-4 w-full max-w-2xl bg-surface rounded animate-pulse" />
        <div className="mt-2 h-4 w-2/3 max-w-2xl bg-surface rounded animate-pulse" />
        <div className="mt-4 flex flex-wrap gap-3">
          <div className="h-3 w-32 bg-surface rounded animate-pulse" />
          <div className="h-3 w-40 bg-surface rounded animate-pulse" />
          <div className="h-3 w-28 bg-surface rounded animate-pulse" />
        </div>
      </header>

      <section className="mt-8 grid grid-cols-2 gap-4 sm:gap-6">
        <div className="flex items-center gap-3 border border-rule p-4 rounded-xl">
          <div className="h-10 w-10 rounded-full bg-surface animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-24 bg-surface rounded animate-pulse" />
            <div className="h-2 w-40 bg-surface rounded animate-pulse" />
          </div>
        </div>
        <div className="flex items-center gap-3 border border-rule p-4 rounded-xl">
          <div className="h-10 w-10 rounded-full bg-surface animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-24 bg-surface rounded animate-pulse" />
            <div className="h-2 w-40 bg-surface rounded animate-pulse" />
          </div>
        </div>
      </section>

      <section className="mt-10">
        <p className="text-[11px] uppercase tracking-[0.18em] text-ink-muted mb-4">
          Loading live measurements
        </p>
        <div className="space-y-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <article
              key={i}
              className="border border-rule rounded-2xl p-5 sm:p-6"
            >
              <div className="mb-5 h-5 w-2/3 bg-surface rounded animate-pulse" />
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                <div className="rounded-xl px-4 py-4 border border-rule bg-surface/40 space-y-3">
                  <div className="h-3 w-20 bg-surface rounded animate-pulse" />
                  <div className="h-10 w-32 bg-surface rounded animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-2 w-full bg-surface rounded animate-pulse" />
                    <div className="h-2 w-full bg-surface rounded animate-pulse" />
                  </div>
                </div>
                <div className="rounded-xl px-4 py-4 border border-rule bg-surface/40 space-y-3">
                  <div className="h-3 w-20 bg-surface rounded animate-pulse" />
                  <div className="h-10 w-32 bg-surface rounded animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-2 w-full bg-surface rounded animate-pulse" />
                    <div className="h-2 w-full bg-surface rounded animate-pulse" />
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
        <p className="mt-6 text-xs text-ink-muted">
          First hit on a brand new pair can take a few seconds while the
          per chain and per region variants fan out. Subsequent visits
          and other users land on the cached render.
        </p>
      </section>
    </main>
  );
}
