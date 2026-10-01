import Link from "next/link";
import { SITE } from "@/data/site";
import { withUtm } from "@/lib/utm";

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
 * What did NOT change is the link set. These are the developer and
 * project surfaces; the left rail carries the editorial sections
 * (/benchmarks, /perps, /rpc and so on). /contact is the one link that
 * sits in both, because the rail is where someone looks for it and the
 * footer is where they happen to be when they need it.
 *
 * Before pruning this row, check the sitemap. FOUR of these are absent
 * from it, so for each of them this footer is the only inbound link on
 * the site: /llms.txt, /api/citable, /api/openapi.json and
 * /api/llm-context. Dropping any one orphans a file the citability work
 * exists to serve. (/partners, /badges, /team, /press and /contact are
 * in the sitemap and would survive a cut here.) An earlier version of
 * this note named only the first two, which read as a complete list and
 * was not, and a later one said "ten" when counting was the point.
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
  { label: "Contact", href: "/contact" },
];

// Legal, kept in its own group after the rule. Both pages are required
// submission fields for the ChatGPT app directory listing of the MCP server.
// They are in the sitemap, but nothing in the rail or the body links them, so
// this row is the only path a reader or a reviewer can follow to reach them.
const LEGAL_LINKS = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
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
            href={withUtm("https://github.com/ChainBench/OpenChainBench/issues/new")}
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
          <span aria-hidden className="h-3 w-px bg-rule" />
          {LEGAL_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-[13px] text-ink-muted hover:text-ink transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <p className="mt-5 border-t border-rule pt-4 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          © {new Date().getFullYear()} OpenChainBench · MIT License · Community-run
        </p>
      </div>
    </footer>
  );
}
