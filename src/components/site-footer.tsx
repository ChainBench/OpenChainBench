import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-rule bg-paper-soft/50">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="display text-2xl text-ink leading-none">OpenChainBench</p>
            <p className="mt-3 max-w-md text-sm text-ink-muted leading-relaxed">
              Open, reproducible benchmarks for crypto infrastructure.
              Methodology, specs and raw metrics are public.
            </p>
            <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              MIT-licensed · Community-run
            </p>
          </div>

          <FooterCol
            title="Read"
            links={[
              { label: "Overview", href: "/" },
              { label: "Benchmarks", href: "/#latest" },
              { label: "Providers", href: "/providers" },
              { label: "Methodology", href: "/methodology" },
              { label: "Press kit", href: "/press" },
            ]}
          />
          <FooterCol
            title="Developers"
            links={[
              { label: "OpenAPI spec", href: "/api/openapi.json" },
              { label: "JSON citation", href: "/api/citable" },
              { label: "LLM context", href: "/api/llm-context" },
              { label: "llms.txt", href: "/llms.txt" },
            ]}
          />
          <FooterCol
            title="Contribute"
            links={[
              { label: "Tutorial", href: "/contribute" },
              { label: "GitHub", href: "https://github.com/OpenChainBench/OpenChainBench" },
              { label: "Open an issue", href: "https://github.com/OpenChainBench/OpenChainBench/issues/new" },
              { label: "@openchainbench", href: "https://twitter.com/openchainbench" },
              { label: "About", href: "/about" },
            ]}
          />
        </div>

        <p className="mt-12 max-w-3xl text-xs text-ink-muted leading-relaxed border-t border-rule pt-6">
          Every benchmark is a YAML spec plus a public harness exposing
          <span className="font-mono text-[0.92em] text-ink-soft"> /metrics</span>.
          The site queries one shared Prometheus and re-renders every minute.
          Anyone can submit a benchmark. the{" "}
          <Link href="/contribute" className="text-ink-soft hover:text-ink underline-offset-4 hover:underline">
            contribution guide
          </Link>{" "}
          walks through it.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
          <span>© {new Date().getFullYear()} OpenChainBench · MIT License</span>
          <span>Set in Inter Tight · Inter · Source Serif 4 · JetBrains Mono</span>
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
      <h4 className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-faint">
        {title}
      </h4>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link className="text-sm text-ink-soft hover:text-ink lnk" href={l.href}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
