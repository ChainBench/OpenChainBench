import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { pageMetadata } from "@/lib/page-metadata";
import { SITE } from "@/data/site";
import { withUtm } from "@/lib/utm";

export const metadata: Metadata = pageMetadata({
  path: "/docs",
  title: "Docs",
  description:
    "Every machine-readable surface OpenChainBench publishes: the MCP server and its four tools, eleven REST endpoints with an OpenAPI 3.1 spec, Markdown views of the pages, llms.txt, four citation formats under CC BY 4.0, embeddable SVG badges and the feeds.",
});

/**
 * The index of everything a machine can read here.
 *
 * Nothing on this page is written from memory. Every endpoint, format,
 * transport and path below was probed against production while the page
 * was written, and the few that are not reachable are either absent or
 * stated as such. The two facts most likely to rot are the tool list and
 * the endpoint table, so both name where the live truth is: tools/list on
 * the server itself, and /api/openapi.json, which is generated rather
 * than hand-written.
 *
 * It does NOT repeat /mcp. That page is the install flow for Claude
 * Desktop, Cursor and VS Code, with the deeplinks and the JSON blocks;
 * this one says what the server is and sends you there.
 */

const MCP_URL = `${SITE.url}/api/mcp/mcp`;

const TOOLS = [
  {
    name: "list_benchmarks",
    body: "Flat index of every published benchmark with its current headline value, leader, category, unit and citation URL. The discovery call.",
  },
  {
    name: "get_benchmark",
    body: "One benchmark in full: every provider ranked by p50, a 24 h sparkline, the headline sentence, a paste-ready citation, the methodology bullets and the source-code URL. Takes chain and region where the bench declares them.",
  },
  {
    name: "list_answers",
    body: "Every answer page: a question in plain words, the sentence that answers it from live data, and the benchmark the number came from. For questions asked in words rather than by bench name.",
  },
  {
    name: "query_prom",
    body: "PromQL passthrough, scoped to the benchmark metric namespaces, for ranges and shapes the two tools above do not cover.",
  },
] as const;

/** The eleven paths the OpenAPI document declares. */
const ENDPOINTS = [
  { path: "/api/stat/{slug}", type: "JSON", body: "One benchmark: rankings, sparkline, and a quote ready to paste. Takes ?chain=, ?region= and ?tier= where the bench declares them." },
  { path: "/api/citable", type: "JSON", body: "Flat index of every citable benchmark with its current value." },
  { path: "/api/citable/{date}", type: "JSON", body: "The same index as it stood on one past day." },
  { path: "/api/cite/{slug}/{format}", type: "bib · ris · apa · txt", body: "One citation record with the right MIME type, so Zotero and EndNote import it directly." },
  { path: "/api/compare/{a}/{b}", type: "JSON", body: "Two providers head to head on every benchmark that measures both." },
  { path: "/api/capital", type: "JSON", body: "The /capital hub in one payload: chains, protocols and the valuation rows." },
  { path: "/api/freshness", type: "JSON", body: "Last resolved data timestamp. A cheap probe before a heavier call." },
  { path: "/api/llm-context", type: "Markdown", body: "Every benchmark, ranking and methodology note as one document." },
  { path: "/api/search/featured", type: "JSON", body: "Live leaders and trending benchmarks." },
  { path: "/api/sparkline/{slug}", type: "SVG", body: "The leader's 24 h series as a standalone image." },
  { path: "/api/og/{slug}", type: "PNG", body: "A 1200x630 card with the current value and sparkline." },
] as const;

/** The paths that answer Markdown. Checked individually: /rpc and
 *  /chains/{slug} do NOT, and saying they did would waste a reader's
 *  afternoon. */
const MARKDOWN_PATHS = ["/benchmarks/{slug}", "/products/{slug}", "/perps", "/rwa", "/capital"];

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-md px-4 py-3 text-[12px] font-mono leading-relaxed" style={{ background: "var(--color-ink)", color: "var(--color-paper, #fff)" }}>
      {children}
    </pre>
  );
}

export default function DocsPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Docs</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Every surface here is readable by a machine without a browser. One MCP server, eleven REST endpoints, the pages themselves as Markdown, and the data under CC BY 4.0.
        </p>
      </header>

      <SectionRule label="Start where you are" />
      <ul className="space-y-3 text-[15px] text-ink-soft leading-relaxed">
        <li>
          <strong className="text-ink">Using an AI assistant.</strong> Point it at the MCP server. <Link className="lnk" href="/mcp">Install instructions</Link> for Claude Desktop, Cursor and VS Code.
        </li>
        <li>
          <strong className="text-ink">Writing code.</strong> The REST endpoints below, or the <a className="lnk" href="/api/openapi.json">OpenAPI 3.1 document</a>.
        </li>
        <li>
          <strong className="text-ink">Scraping or citing.</strong> Ask any benchmark page for Markdown, or take the citation record in the format your tool wants.
        </li>
        <li>
          <strong className="text-ink">Wondering how a number was produced.</strong> That is <Link className="lnk" href="/methodology">methodology</Link>, and every bench page links the harness that produced it.
        </li>
      </ul>

      <SectionRule label="MCP server" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        Streamable HTTP, no auth, 60 requests per minute per IP. The <code className="font-mono text-[13px]">mcp</code> transport is the only one served.
      </p>
      <Code>{MCP_URL}</Code>
      <p className="mt-4 text-[15px] text-ink-soft leading-relaxed">Four tools:</p>
      <ul className="mt-2 space-y-3">
        {TOOLS.map((t) => (
          <li key={t.name} className="border-l-2 border-rule pl-4">
            <code className="font-mono text-[13px] text-ink">{t.name}</code>
            <p className="mt-1 text-[14px] text-ink-soft leading-relaxed">{t.body}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[13px] text-ink-faint leading-relaxed">
        The server answers <code className="font-mono">tools/list</code>, which is the version of this list that cannot go stale.
      </p>

      <SectionRule label="REST API" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        No key, no signup. Responses are cached at the edge, so a client that polls faster than the data moves is served from cache rather than rate-limited.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Path</th>
              <th>Returns</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.path}>
                <td className="font-mono text-[12px] whitespace-nowrap">{e.path}</td>
                <td className="text-[12px] whitespace-nowrap text-ink-soft">{e.type}</td>
                <td className="text-[13px] text-ink-soft">{e.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-[13px] text-ink-faint leading-relaxed">
        The <a className="lnk" href="/api/openapi.json">OpenAPI document</a> is generated from the routes, so it is the one to trust if this table and it ever disagree.
      </p>

      <SectionRule label="Pages as Markdown" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        Send <code className="font-mono text-[13px]">Accept: text/markdown</code> and these paths answer with the table instead of the DOM. An agent gets the numbers without parsing HTML.
      </p>
      <Code>{`curl -H 'Accept: text/markdown' ${SITE.url}/benchmarks/ethereum-rpc`}</Code>
      <p className="mt-3 text-[14px] text-ink-soft leading-relaxed">
        Served for: {MARKDOWN_PATHS.map((p, i) => (
          <span key={p}>
            <code className="font-mono text-[13px]">{p}</code>
            {i < MARKDOWN_PATHS.length - 1 ? ", " : ""}
          </span>
        ))}. Other paths answer HTML whatever the header says.
      </p>

      <SectionRule label="Files written for agents" />
      <ul className="space-y-2 text-[15px] text-ink-soft leading-relaxed">
        <li>
          <a className="lnk font-mono text-[13px]" href="/llms.txt">/llms.txt</a> · the site in the llms.txt convention: what each section holds and when to cite it.
        </li>
        <li>
          <a className="lnk font-mono text-[13px]" href="/llms-full.txt">/llms-full.txt</a> · the same, expanded, with the benchmark catalogue inline.
        </li>
        <li>
          <a className="lnk font-mono text-[13px]" href="/api/llm-context">/api/llm-context</a> · every ranking and methodology note as one Markdown document.
        </li>
      </ul>

      <SectionRule label="Citing a number" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        The data is <a className="lnk" href={withUtm("https://creativecommons.org/licenses/by/4.0/")} rel="license noopener">CC BY 4.0</a>. Attribution is OpenChainBench plus the benchmark page. The dataset has two Zenodo DOIs and they are not interchangeable. <code className="font-mono text-[13px]">10.5281/zenodo.20800311</code> is the concept DOI and always resolves to the newest version, which is what a living reference wants. <code className="font-mono text-[13px]">10.5281/zenodo.20800312</code> is the current version, v1.0.1-dataset, and is the one to cite when a result has to stay reproducible.
      </p>
      <Code>{`${SITE.url}/api/cite/ethereum-rpc/bib    # BibTeX
${SITE.url}/api/cite/ethereum-rpc/ris    # RIS, for Zotero and EndNote
${SITE.url}/api/cite/ethereum-rpc/apa    # APA, as plain text
${SITE.url}/api/cite/ethereum-rpc/txt    # one sentence with the value and date`}</Code>
      <p className="mt-3 text-[14px] text-ink-soft leading-relaxed">
        A benchmark page moves. <Link className="lnk font-mono text-[13px]" href="/api/citable">/api/citable</Link> is the index as it stands now, and <code className="font-mono text-[13px]">/api/citable/{"{date}"}</code> is that index as it stood on a past day, which is what a paper should point at.
      </p>

      <SectionRule label="Badges and embeds" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        An SVG badge with a live value, for a README or a status page. The <Link className="lnk" href="/badges">badges catalog</Link> has one per benchmark and provider, and <Link className="lnk" href="/partners">partners</Link> carries the embed terms.
      </p>
      <Code>{`${SITE.url}/api/badge/ethereum-rpc/drpc`}</Code>

      <SectionRule label="Feeds" />
      <ul className="space-y-2 text-[15px] text-ink-soft leading-relaxed">
        <li><a className="lnk font-mono text-[13px]" href="/rss.xml">/rss.xml</a> and <a className="lnk font-mono text-[13px]" href="/feed.json">/feed.json</a> · new benchmarks and reports.</li>
        <li><a className="lnk font-mono text-[13px]" href="/sitemap.xml">/sitemap.xml</a> · every indexable page with its last-modified date.</li>
      </ul>

      <SectionRule label="The same data, elsewhere" />
      <ul className="space-y-2 text-[15px] text-ink-soft leading-relaxed">
        <li>
          <a className="lnk" href={withUtm("https://huggingface.co/datasets/OpenChainBench/benchmarks")} rel="noopener" target="_blank">Hugging Face dataset</a> · the catalogue as a dataset, for notebooks and training sets.
        </li>
        <li>
          <a className="lnk" href={withUtm("https://huggingface.co/spaces/OpenChainBench/leaderboard")} rel="noopener" target="_blank">Hugging Face Space</a> · the leaderboard as a hosted app.
        </li>
        <li>
          <a className="lnk" href={withUtm("https://github.com/ChainBench/OpenChainBench")} rel="noopener" target="_blank">GitHub</a> · the specs, every harness, and the site itself. MIT for the code.
        </li>
      </ul>

      <SectionRule label="If something here is wrong" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        A broken endpoint or a number that does not reproduce is worth a report, and both have a destination on the <Link className="lnk" href="/contact">contact page</Link>. Adding a benchmark of your own is <Link className="lnk" href="/contribute">contribute</Link>.
      </p>
    </article>
  );
}
