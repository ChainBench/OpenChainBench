/**
 * "Same probe on other chains": every indexable chain RPC page, linked from
 * every other one. Before this, a chain page linked at most 6 of its 116
 * siblings (the "More benchmarks" rail cap) and named others in prose
 * without a link, so the RPC cluster had almost no internal linking of its
 * own (audit 2026-09-19, minor 6). Only benches the worker publishes in
 * the sitemap are listed: thin ones are noindex on their own page.
 */
import Link from "next/link";
import { isExpiredRpcPage } from "@/lib/provider-filters";
import { getSpecs } from "@/lib/spec";
import { loadSitemapBlob } from "@/lib/sitemap-blob";
import { NON_CHAIN_RPC_SLUGS } from "@/lib/rpc-hub-stats";

function chainLabel(title: string, slug: string): string {
  const m = title.match(/free ([A-Za-z0-9 .-]+?) RPC/i) ?? title.match(/^([A-Za-z0-9 .-]+?) RPC/i);
  return m ? m[1] : slug.replace(/-rpc$/, "");
}

export async function RpcSiblingChains({ currentSlug }: { currentSlug: string }) {
  const [specs, blob] = await Promise.all([getSpecs(), loadSitemapBlob()]);
  const indexable = blob
    ? new Set(blob.benches.filter((b) => !isExpiredRpcPage(b)).map((b) => b.slug))
    : null;
  const siblings = specs
    .filter((s) => s.slug.endsWith("-rpc") && !NON_CHAIN_RPC_SLUGS.has(s.slug) && s.slug !== currentSlug)
    .filter((s) => !indexable || indexable.has(s.slug))
    .map((s) => ({ slug: s.slug, label: chainLabel(s.title, s.slug) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (siblings.length < 3) return null;
  return (
    <nav className="mt-10 max-w-3xl" aria-labelledby="rpc-siblings">
      <h2 id="rpc-siblings" className="label-mono text-ink-muted">
        Same probe on other chains
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        The identical no-key probe runs on {siblings.length} other chains; each page lists its
        public endpoints and ranks them the same way.
      </p>
      <ul className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
        {siblings.map((s) => (
          <li key={s.slug}>
            <Link href={`/benchmarks/${s.slug}`} className="pill-lnk">
              {s.label}
              <span className="sr-only"> RPC endpoints</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
