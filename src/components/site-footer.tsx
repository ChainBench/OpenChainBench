import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-rule">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="font-serif text-3xl font-bold tracking-tight">
              OpenChainBench
            </p>
            <p className="mt-2 font-serif italic text-ink-soft max-w-md">
              Open, reproducible benchmarks for crypto infrastructure.
              Methodology, specs and raw metrics are public. Anyone can
              submit.
            </p>
            <p className="mt-4 font-sans text-[11px] uppercase tracking-[0.2em] text-ink-muted">
              MIT-licensed · Community-run
            </p>
          </div>

          <FooterCol
            title="Read"
            links={[
              { label: "All benchmarks", href: "/benchmarks" },
              { label: "Methodology", href: "/methodology" },
              { label: "About", href: "/about" },
              { label: "Press kit", href: "/press" },
            ]}
          />
          <FooterCol
            title="Contribute"
            links={[
              { label: "Tutorial", href: "/contribute" },
              { label: "GitHub", href: "https://github.com/Flotapponnier/OpenChainBench" },
              { label: "Open an issue", href: "https://github.com/Flotapponnier/OpenChainBench/issues/new" },
              { label: "RSS", href: "/rss.xml" },
            ]}
          />
          <FooterCol
            title="Follow"
            links={[
              { label: "@openchainbench", href: "https://twitter.com/openchainbench" },
              { label: "r/openchainbench", href: "https://reddit.com/r/openchainbench" },
            ]}
          />
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-6 font-sans text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          <span>© {new Date().getFullYear()} OpenChainBench · MIT License</span>
          <span>Set in Source Serif 4 · Inter · JetBrains Mono</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div className="md:col-span-2">
      <h4 className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink-muted">
        {title}
      </h4>
      <ul className="mt-3 space-y-2 font-serif">
        {links.map((l) => (
          <li key={l.href}>
            <Link className="lnk" href={l.href}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
