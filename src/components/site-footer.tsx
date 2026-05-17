import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-rule bg-surface">
      <div className="mx-auto max-w-[1400px] px-6 py-12">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <div className="flex items-center gap-2">
              <SiteLogo size={20} />
              <p className="font-bold tracking-tight text-[15px] text-ink">
                OpenChainBench
              </p>
            </div>
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
              { label: "Benchmarks", href: "/benchmarks" },
              { label: "Providers", href: "/providers" },
              { label: "Methodology", href: "/methodology" },
              { label: "Press kit", href: "/press" },
            ]}
          />
          <FooterCol
            title="Developers"
            links={[
              { label: "MCP server", href: "/mcp" },
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

        <div className="mt-10 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-[0.16em] text-ink-muted border-t border-rule pt-6">
          <span>© {new Date().getFullYear()} OpenChainBench · MIT License</span>
          <Link href="/about" className="hover:text-ink transition-colors">
            About
          </Link>
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
            <Link className="text-sm text-ink-muted hover:text-ink transition-colors" href={l.href}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
