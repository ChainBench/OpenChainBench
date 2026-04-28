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

  return (
    <header className="border-b border-rule bg-bg/80 backdrop-blur-md sticky top-0 z-40">
      <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-3">
          <span className="wordmark text-[1.4rem] sm:text-[1.55rem] text-ink leading-none">
            OpenChainBench
          </span>
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                liveCount > 0 ? "bg-good animate-pulse" : "bg-ink-faint"
              }`}
            />
            {liveCount > 0 ? `${liveCount} live` : "draft"}
          </span>
        </Link>

        <nav className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-soft hover:text-ink hover:bg-bg-soft transition-colors"
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-sm font-medium text-bg hover:bg-accent-soft transition-colors"
          >
            Read benchmarks
          </Link>
        </div>
      </div>
    </header>
  );
}
