import Link from "next/link";
import { SITE } from "@/data/site";

/**
 * Compact footer, one row of links plus the legal line.
 *
 * It used to carry a logo lockup, a tagline and a "MIT-licensed ·
 * Community-run" line above two link columns. Against the rail-and-inset
 * shell that reads as a different era of the site: a full-bleed masthead
 * block sitting under a rounded, inset content pane. The logo is already
 * in the header on every page and the tagline is the home page's own H1
 * territory, so all three were repetition paying for a third of the
 * viewport.
 *
 * What did NOT change is the link set. None of these ten appear in the
 * left rail: the rail carries the editorial sections (/benchmarks,
 * /perps, /rpc and so on) and this carries the developer and project
 * surfaces.
 *
 * Before pruning this row, check the sitemap. FOUR of these ten are
 * absent from it, so for each of them this footer is the only inbound
 * link on the site: /llms.txt, /api/citable, /api/openapi.json and
 * /api/llm-context. Dropping any one orphans a file the citability work
 * exists to serve. (/partners, /badges, /team and /press are in the
 * sitemap and would survive a cut here.) An earlier version of this note
 * named only the first two, which read as a complete list and was not.
 */
const DEVELOPER_LINKS = [
  { label: "Partners + embeds", href: "/partners" },
  { label: "Badges catalog", href: "/badges" },
  { label: "OpenAPI spec", href: "/api/openapi.json" },
  { label: "JSON citation", href: "/api/citable" },
  { label: "LLM context", href: "/api/llm-context" },
  { label: "llms.txt", href: "/llms.txt" },
];

const PROJECT_LINKS = [
  { label: "Team", href: "/team" },
  { label: "Press kit", href: "/press" },
];

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-rule bg-surface">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-6">
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {DEVELOPER_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-[13px] text-ink-muted hover:text-ink transition-colors"
            >
              {l.label}
            </Link>
          ))}
          <span aria-hidden className="h-3 w-px bg-rule" />
          {PROJECT_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-[13px] text-ink-muted hover:text-ink transition-colors"
            >
              {l.label}
            </Link>
          ))}
          <a
            href="https://github.com/ChainBench/OpenChainBench/issues/new"
            className="text-[13px] text-ink-muted hover:text-ink transition-colors"
          >
            Open an issue
          </a>
          <a
            href={`mailto:${SITE.email}`}
            className="text-[13px] text-ink-muted hover:text-ink transition-colors"
          >
            Email
          </a>
        </nav>

        <p className="mt-5 border-t border-rule pt-4 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          © {new Date().getFullYear()} OpenChainBench · MIT License · Community-run
        </p>
      </div>
    </footer>
  );
}
