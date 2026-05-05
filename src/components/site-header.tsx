import Link from "next/link";
import Image from "next/image";
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
    <header className="border-b border-rule bg-paper/85 backdrop-blur-md sticky top-0 z-40">
      {/* Masthead. logo · nav · live status · github */}
      <div className="mx-auto max-w-7xl px-6 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Image
            src="/logo.png"
            alt="OpenChainBench"
            width={28}
            height={28}
            priority
            className="h-7 w-7 object-contain"
          />
          <span className="display text-[1.25rem] text-ink leading-none">
            OpenChainBench
          </span>
        </Link>

        <nav className="hidden md:block ml-auto">
          <ul className="flex items-center gap-5">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-sm text-ink-soft hover:text-ink transition-colors"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <span
          className="hidden sm:inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted shrink-0"
          aria-label={`${liveCount} of ${benchmarks.length} benchmarks live, ${Math.round(totalSamples).toLocaleString()} samples in the last 24 hours`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              liveCount > 0 ? "bg-good animate-pulse" : "bg-ink-faint"
            }`}
          />
          {liveCount}/{benchmarks.length} live
          {totalSamples > 0 && (
            <span className="hidden lg:inline">
              <span className="mx-1.5 text-ink-faint/50">·</span>
              {Math.round(totalSamples).toLocaleString()} samples
            </span>
          )}
        </span>

        <a
          href="https://github.com/OpenChainBench/OpenChainBench"
          className="hidden sm:inline text-sm text-ink-muted hover:text-ink transition-colors shrink-0"
          aria-label="View source on GitHub"
        >
          GitHub
        </a>
      </div>
    </header>
  );
}
