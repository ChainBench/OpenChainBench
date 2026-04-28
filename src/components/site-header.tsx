import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/methodology", label: "Methodology" },
  { href: "/contribute", label: "Contribute" },
];

export async function SiteHeader() {
  const benchmarks = await getBenchmarks();
  const liveCount = benchmarks.filter((b) => b.status === "live").length;
  const totalSamples = benchmarks.reduce((s, b) => s + b.sampleSize, 0);

  return (
    <header className="border-b border-rule bg-bg/85 backdrop-blur-md sticky top-0 z-40">
      {/* Live ticker */}
      <div className="border-b border-rule bg-bg-soft/60">
        <div className="mx-auto max-w-7xl px-6 py-1.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 font-mono text-[10px] tabular text-ink-muted">
          <span className="flex items-center gap-2">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                liveCount > 0 ? "bg-good animate-pulse" : "bg-ink-faint"
              }`}
            />
            <span className="uppercase tracking-[0.18em]">
              {liveCount > 0
                ? `${liveCount} of ${benchmarks.length} live`
                : `${benchmarks.length} benchmark${benchmarks.length === 1 ? "" : "s"} · awaiting first runs`}
            </span>
          </span>
          {totalSamples > 0 && (
            <span className="hidden sm:inline">
              {Math.round(totalSamples).toLocaleString()} samples · last 24h
            </span>
          )}
          <span className="hidden md:inline">
            <Link href="/contribute" className="lnk">
              Submit a benchmark ↗
            </Link>
          </span>
        </div>
      </div>

      {/* Masthead — wordmark + nav + CTA */}
      <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-3 group">
          <span className="display text-[1.55rem] sm:text-[1.7rem] text-ink leading-none">
            OpenChainBench
          </span>
          <span className="hidden lg:inline editorial text-sm text-ink-muted leading-none">
            — a field journal of crypto-infra performance
          </span>
        </Link>

        <nav className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft hover:text-ink hover:bg-bg-soft transition-colors"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-1">
          <a
            href="https://github.com/OpenChainBench/OpenChainBench"
            className="hidden sm:inline-flex items-center px-3 py-1.5 text-sm font-medium text-ink-soft hover:text-ink"
          >
            GitHub
          </a>
          <Link
            href="/benchmarks"
            className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-bg hover:bg-ink-soft transition-colors"
          >
            Read benchmarks
          </Link>
        </div>
      </div>
    </header>
  );
}
