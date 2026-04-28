import Link from "next/link";
import { getBenchmarks } from "@/data/benchmarks";
import { CURRENT_ISSUE } from "@/data/site";

export async function SiteHeader() {
  const benchmarks = await getBenchmarks();
  const totalSamples = benchmarks.reduce((s, b) => s + b.sampleSize, 0);
  const totalProviders = benchmarks.reduce((s, b) => s + b.results.length, 0);
  const dateLong = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <header className="border-b border-rule">
      {/* Live ticker */}
      <div className="border-b border-rule bg-paper-deep/70">
        <div className="mx-auto max-w-7xl px-6 py-1.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 font-mono text-[10px] tabular text-ink-soft">
          <span className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-flag-good animate-pulse" />
            <span className="uppercase tracking-[0.2em]">
              Live · {benchmarks.length} benchmarks running
            </span>
          </span>
          <span className="hidden sm:inline">
            {totalProviders} providers · {totalSamples.toLocaleString()} samples
            in last 24h
          </span>
          <span className="hidden md:inline">
            <a href="#latest" className="lnk">
              Jump to latest report ↓
            </a>
          </span>
        </div>
      </div>

      {/* Masthead */}
      <div className="mx-auto max-w-7xl px-6 pt-10 pb-5">
        <div className="flex items-baseline justify-between font-sans text-[11px] uppercase tracking-[0.22em] text-ink-soft">
          <span>Vol. I · Issue {CURRENT_ISSUE}</span>
          <span className="hidden sm:inline italic font-serif normal-case tracking-normal text-ink-soft">
            {dateLong}
          </span>
          <span>Open · Reproducible · Independent</span>
        </div>

        <Link href="/" className="mt-4 block group">
          <h1 className="font-serif text-5xl sm:text-7xl md:text-[5.5rem] font-bold tracking-tight leading-[0.92] text-ink">
            OpenChainBench
          </h1>
        </Link>

        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <p className="font-serif italic text-ink-soft text-base sm:text-lg max-w-2xl">
            A field journal of crypto-infrastructure performance &mdash;
            measured in the open.
          </p>
          <p className="font-mono text-[10px] tabular uppercase tracking-[0.2em] text-ink-muted">
            Est. 2026 · No. {CURRENT_ISSUE} · openchainbench.xyz
          </p>
        </div>

        <div className="mt-5 rule-double" />
      </div>

      {/* Nav */}
      <nav className="mx-auto max-w-7xl px-6 pb-3">
        <ul className="flex flex-wrap items-center gap-x-7 gap-y-2 font-sans text-[12px] uppercase tracking-[0.18em]">
          <NavLink href="/">Front Page</NavLink>
          <NavLink href="/benchmarks">Benchmarks</NavLink>
          <NavLink href="/methodology">Methodology</NavLink>
          <NavLink href="/about">About</NavLink>
          <NavLink href="/press">Press Kit</NavLink>
          <li className="ml-auto flex items-center gap-5 text-ink-soft normal-case tracking-normal">
            <a className="lnk" href="https://github.com/mobula/openchainbench">
              GitHub ↗
            </a>
            <a className="lnk" href="https://twitter.com/openchainbench">
              Twitter ↗
            </a>
            <a className="lnk" href="https://reddit.com/r/openchainbench">
              Reddit ↗
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        className="text-ink hover:text-accent transition-colors"
        href={href}
      >
        {children}
      </Link>
    </li>
  );
}
