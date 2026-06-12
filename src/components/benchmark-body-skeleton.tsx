/**
 * Server-rendered placeholder for BenchmarkBody while the client bundle
 * hydrates. BenchmarkBody bails out to client rendering (useSearchParams),
 * so without this the leaderboard area is blank space on slow connections
 * and the page visibly jumps when it mounts. Heights approximate the real
 * layout (tab row, summary strip, chart, ledger rows) to keep layout shift
 * minimal.
 */
export function BenchmarkBodySkeleton() {
  return (
    <div aria-hidden className="mt-8 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="h-6 w-24 rounded bg-paper-soft" />
        <div className="h-6 w-20 rounded bg-paper-soft" />
        <div className="h-6 w-20 rounded bg-paper-soft" />
      </div>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="h-16 rounded bg-paper-soft" />
        <div className="h-16 rounded bg-paper-soft" />
        <div className="h-16 rounded bg-paper-soft" />
        <div className="h-16 rounded bg-paper-soft" />
      </div>
      <div className="mt-6 h-[300px] rounded bg-paper-soft" />
      <div className="mt-6 space-y-2">
        <div className="h-10 rounded bg-paper-soft" />
        <div className="h-10 rounded bg-paper-soft" />
        <div className="h-10 rounded bg-paper-soft" />
        <div className="h-10 rounded bg-paper-soft" />
        <div className="h-10 rounded bg-paper-soft" />
      </div>
    </div>
  );
}
