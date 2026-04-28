import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-32 border-t border-rule bg-bg-soft">
      <div className="mx-auto max-w-7xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="wordmark text-2xl text-ink">OpenChainBench</p>
            <p className="mt-3 max-w-md text-sm text-ink-muted leading-relaxed">
              Open, reproducible benchmarks for crypto infrastructure.
              Methodology, specs and raw metrics are public. Anyone can
              submit.
            </p>
            <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              MIT-licensed · Community-run
            </p>
          </div>

          <FooterCol
            title="Read"
            links={[
              { label: "Overview", href: "/" },
              { label: "Benchmarks", href: "/benchmarks" },
              { label: "Methodology", href: "/methodology" },
              { label: "Press kit", href: "/press" },
            ]}
          />
          <FooterCol
            title="Contribute"
            links={[
              { label: "Tutorial", href: "/contribute" },
              { label: "GitHub", href: "https://github.com/OpenChainBench/OpenChainBench" },
              { label: "Open an issue", href: "https://github.com/OpenChainBench/OpenChainBench/issues/new" },
            ]}
          />
          <FooterCol
            title="Follow"
            links={[
              { label: "@openchainbench", href: "https://twitter.com/openchainbench" },
              { label: "r/openchainbench", href: "https://reddit.com/r/openchainbench" },
              { label: "About", href: "/about" },
            ]}
          />
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-6 text-xs text-ink-muted">
          <span>© {new Date().getFullYear()} OpenChainBench · MIT License</span>
          <span>Open source · v0.1.0</span>
        </div>
      </div>
    </footer>
  );
}

type FooterLink = { label: string; href: string };

function FooterCol({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div className="md:col-span-2">
      <h4 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
        {title}
      </h4>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-sm text-ink-soft hover:text-ink transition-colors">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
