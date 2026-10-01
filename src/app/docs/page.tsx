import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { SITE } from "@/data/site";
import { withUtm } from "@/lib/utm";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/docs",
  // 254 characters was the first draft, which Google truncates at about
  // 160. This says the same thing in one line a search result can show.
  description:
    "The MCP server and its four tools, eleven REST endpoints, every benchmark page as Markdown, and four citation formats. No key, no signup, CC BY 4.0.",
  title: "Docs",
});

/**
 * The index of everything a machine can read here, laid out like
 * /methodology: one numbered section per surface, cards rather than
 * prose, and a contents list at the top because this page is reference
 * material people arrive at mid-task rather than something read in order.
 *
 * Nothing on this page is written from memory. Every endpoint, format,
 * transport and path below was probed against production while the page
 * was written. The two facts most likely to rot say where the live truth
 * is: tools/list on the server itself, and /api/openapi.json, which is
 * generated from the routes rather than hand-written.
 *
 * It does NOT repeat /mcp. That page is the install flow for Claude
 * Desktop, Cursor and VS Code, with the deeplinks and the JSON blocks;
 * this one says what the server is and sends you there.
 */

const MCP_URL = `${SITE.url}/api/mcp/mcp`;

const SECTIONS = [
  { n: "I", id: "start", label: "Where to start" },
  { n: "II", id: "mcp", label: "MCP server" },
  { n: "III", id: "rest", label: "REST API" },
  { n: "IV", id: "markdown", label: "Pages as Markdown" },
  { n: "V", id: "agents", label: "Files written for agents" },
  { n: "VI", id: "citing", label: "Citing a number" },
  { n: "VII", id: "badges", label: "Badges and embeds" },
  { n: "VIII", id: "feeds", label: "Feeds and mirrors" },
] as const;

const START = [
  {
    n: "Using an AI assistant",
    color: "var(--color-good, #6a9466)",
    body: "Point it at the MCP server and the benchmarks become a tool your model can call.",
    href: "/mcp",
    cta: "Install instructions",
  },
  {
    n: "Writing code",
    color: "var(--color-accent, #c97c5d)",
    body: "Eleven REST endpoints, no key and no signup, described by an OpenAPI 3.1 document.",
    href: "/api/openapi.json",
    cta: "OpenAPI document",
  },
  {
    n: "Scraping or citing",
    color: "var(--color-warn, #c08a3c)",
    body: "Ask any benchmark page for Markdown, or take a citation record in the format your tool imports.",
    href: "#citing",
    cta: "Citation formats",
  },
  {
    n: "Checking how a number was made",
    color: "var(--color-info, #5b7fa6)",
    body: "Every figure is a query against a public Prometheus, and every bench links the harness that produced it.",
    href: "/methodology",
    cta: "Methodology",
  },
] as const;

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
 *  /chains/{slug} do NOT, and saying they did would waste an afternoon. */
const MARKDOWN_PATHS = ["/benchmarks/{slug}", "/products/{slug}", "/perps", "/rwa", "/capital"];

const AGENT_FILES = [
  { href: "/llms.txt", body: "The site in the llms.txt convention: what each section holds and when to cite it." },
  { href: "/llms-full.txt", body: "The same, expanded, with the benchmark catalogue inline." },
  { href: "/api/llm-context", body: "Every ranking and methodology note as one Markdown document." },
] as const;

const MIRRORS = [
  { href: "https://huggingface.co/datasets/OpenChainBench/benchmarks", label: "Hugging Face dataset", body: "The catalogue as a dataset, for notebooks and training sets." },
  { href: "https://huggingface.co/spaces/OpenChainBench/leaderboard", label: "Hugging Face Space", body: "The leaderboard as a hosted app." },
  { href: "https://github.com/ChainBench/OpenChainBench", label: "GitHub", body: "The specs, every harness, and the site itself. MIT for the code." },
] as const;

function SectionHeader({ number, label, id }: { number: string; label: string; id: string }) {
  return (
    <header id={id} className="flex items-baseline gap-3 border-b border-rule pb-2 scroll-mt-24">
      <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
        Section {number}
      </span>
      <h2 className="display text-xl sm:text-2xl text-ink leading-none">{label}</h2>
    </header>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre
      className="mt-4 overflow-x-auto rounded-xl px-5 py-4 text-[12px] font-mono leading-relaxed"
      style={{ background: "var(--color-ink)", color: "var(--color-paper, #fff)" }}
    >
      {children}
    </pre>
  );
}

export default function DocsPage() {
  return (
    <article className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12">
      {/* Hero */}
      <header className="pb-2">
        <h1 className="display text-4xl sm:text-5xl tracking-tight text-ink">Docs</h1>
        <p className="mt-4 max-w-3xl text-base sm:text-lg text-ink-muted leading-snug">
          Every surface here is readable by a machine without a browser. One MCP
          server, eleven REST endpoints, the pages themselves as Markdown, and
          the data under CC BY 4.0. No key and no signup for any of it.
        </p>
      </header>

      {/* Contents. This page is reference material people arrive at
          mid-task, so the sections are listed before the first one. */}
      <nav aria-label="Contents" className="mt-10 card-soft rounded-xl p-5 sm:p-6">
        <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
          Contents
        </p>
        <ol className="mt-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <li key={s.id} className="flex items-baseline gap-3">
              <span className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint w-8 shrink-0">
                {s.n}
              </span>
              <a href={`#${s.id}`} className="text-[15px] text-ink-soft hover:text-ink transition-colors">
                {s.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* I. Where to start */}
      <section className="mt-14">
        <SectionHeader number="I" label="Where to start" id="start" />
        <ol className="mt-6 grid gap-4 sm:grid-cols-2">
          {START.map((p) => (
            <li
              key={p.n}
              className="card-soft rounded-xl p-6 sm:p-7 relative overflow-hidden"
              style={{ ["--accent" as string]: p.color }}
            >
              <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: p.color }} aria-hidden />
              <h3 className="display text-lg sm:text-xl text-ink leading-tight">{p.n}</h3>
              <p className="mt-2 text-sm text-ink-soft leading-relaxed">{p.body}</p>
              {p.href.startsWith("#") ? (
                <a href={p.href} className="lnk mt-3 inline-block text-sm">
                  {p.cta}
                </a>
              ) : (
                <Link href={p.href} className="lnk mt-3 inline-block text-sm">
                  {p.cta}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* II. MCP */}
      <section className="mt-16">
        <SectionHeader number="II" label="MCP server" id="mcp" />
        <p className="mt-6 max-w-3xl text-[15px] text-ink-soft leading-relaxed">
          Streamable HTTP, no auth, 60 requests per minute per IP. The{" "}
          <code className="font-mono text-[13px]">mcp</code> transport is the only one served.{" "}
          <Link className="lnk" href="/mcp">
            Install it
          </Link>{" "}
          in Claude Desktop, Cursor or VS Code.
        </p>
        <Code>{MCP_URL}</Code>
        <dl className="mt-6 card-soft rounded-xl divide-y divide-rule overflow-hidden">
          {TOOLS.map((t) => (
            <div
              key={t.name}
              className="group relative grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-1 sm:gap-8 py-4 px-5 hover:bg-paper-soft/40 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-accent before:opacity-0 hover:before:opacity-100 before:transition-opacity"
            >
              <dt className="font-mono text-[13px] text-ink pt-0.5 group-hover:text-accent transition-colors">
                {t.name}
              </dt>
              <dd className="text-sm text-ink-soft leading-relaxed">{t.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-ink-faint leading-relaxed">
          The server answers <code className="font-mono">tools/list</code>, which is the version of
          this list that cannot go stale.
        </p>
      </section>

      {/* III. REST */}
      <section className="mt-16">
        <SectionHeader number="III" label="REST API" id="rest" />
        <p className="mt-6 max-w-3xl text-[15px] text-ink-soft leading-relaxed">
          No key, no signup. Responses are cached at the edge, so a client that polls faster than
          the data moves is served from cache rather than rate-limited.
        </p>
        <div className="mt-6 card-soft rounded-xl divide-y divide-rule overflow-hidden">
          {ENDPOINTS.map((e) => (
            <div
              key={e.path}
              className="group relative grid grid-cols-1 sm:grid-cols-[18rem_1fr] gap-1 sm:gap-8 py-4 px-5 hover:bg-paper-soft/40 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-accent before:opacity-0 hover:before:opacity-100 before:transition-opacity"
            >
              <div className="min-w-0">
                <p className="font-mono text-[13px] text-ink break-all group-hover:text-accent transition-colors">
                  {e.path}
                </p>
                <p className="mt-0.5 font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                  {e.type}
                </p>
              </div>
              <p className="text-sm text-ink-soft leading-relaxed">{e.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-ink-faint leading-relaxed">
          The <Link className="lnk" href="/api/openapi.json">OpenAPI document</Link> is generated
          from the routes, so it is the one to trust if this table and it ever disagree.
        </p>
      </section>

      {/* IV. Markdown */}
      <section className="mt-16">
        <SectionHeader number="IV" label="Pages as Markdown" id="markdown" />
        <p className="mt-6 max-w-3xl text-[15px] text-ink-soft leading-relaxed">
          Send <code className="font-mono text-[13px]">Accept: text/markdown</code> and these paths
          answer with the table instead of the DOM. An agent gets the numbers without parsing HTML.
        </p>
        <Code>{`curl -H 'Accept: text/markdown' ${SITE.url}/benchmarks/ethereum-rpc`}</Code>
        <div className="mt-4 flex flex-wrap gap-2">
          {MARKDOWN_PATHS.map((p) => (
            <code key={p} className="card-soft rounded-lg px-3 py-1.5 font-mono text-[12px] text-ink-soft">
              {p}
            </code>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-ink-faint leading-relaxed">
          Every other path answers HTML whatever the header asks for, <code className="font-mono">/rpc</code>{" "}
          and <code className="font-mono">/chains/{"{slug}"}</code> included.
        </p>
      </section>

      {/* V. Agent files */}
      <section className="mt-16">
        <SectionHeader number="V" label="Files written for agents" id="agents" />
        <dl className="mt-6 card-soft rounded-xl divide-y divide-rule overflow-hidden">
          {AGENT_FILES.map((f) => (
            <div
              key={f.href}
              className="group relative grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-1 sm:gap-8 py-4 px-5 hover:bg-paper-soft/40 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-accent before:opacity-0 hover:before:opacity-100 before:transition-opacity"
            >
              <dt className="pt-0.5">
                <Link className="lnk font-mono text-[13px]" href={f.href}>
                  {f.href}
                </Link>
              </dt>
              <dd className="text-sm text-ink-soft leading-relaxed">{f.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* VI. Citing */}
      <section className="mt-16">
        <SectionHeader number="VI" label="Citing a number" id="citing" />
        <p className="mt-6 max-w-3xl text-[15px] text-ink-soft leading-relaxed">
          The data is{" "}
          <a className="lnk" href={withUtm("https://creativecommons.org/licenses/by/4.0/")} rel="license noopener">
            CC BY 4.0
          </a>
          . Attribution is OpenChainBench plus the benchmark page.
        </p>
        <Code>{`${SITE.url}/api/cite/ethereum-rpc/bib    # BibTeX
${SITE.url}/api/cite/ethereum-rpc/ris    # RIS, for Zotero and EndNote
${SITE.url}/api/cite/ethereum-rpc/apa    # APA, as plain text
${SITE.url}/api/cite/ethereum-rpc/txt    # one sentence with the value and date`}</Code>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="card-soft rounded-xl p-5">
            <h3 className="display text-base text-ink">Two DOIs, not interchangeable</h3>
            <p className="mt-2 text-sm text-ink-soft leading-relaxed">
              <code className="font-mono text-[12px]">10.5281/zenodo.20800311</code> is the concept
              DOI and follows the newest version, which is what a living reference wants.{" "}
              <code className="font-mono text-[12px]">10.5281/zenodo.20800312</code> is the current
              version, v1.0.1-dataset, and is the one to cite when a result has to stay reproducible.
            </p>
          </div>
          <div className="card-soft rounded-xl p-5">
            <h3 className="display text-base text-ink">A benchmark page moves</h3>
            <p className="mt-2 text-sm text-ink-soft leading-relaxed">
              <Link className="lnk font-mono text-[12px]" href="/api/citable">
                /api/citable
              </Link>{" "}
              is the index as it stands now.{" "}
              <code className="font-mono text-[12px]">/api/citable/{"{date}"}</code> is that index as
              it stood on a past day, which is what a paper should point at.
            </p>
          </div>
        </div>
      </section>

      {/* VII. Badges */}
      <section className="mt-16">
        <SectionHeader number="VII" label="Badges and embeds" id="badges" />
        <p className="mt-6 max-w-3xl text-[15px] text-ink-soft leading-relaxed">
          An SVG badge with a live value, for a README or a status page. The{" "}
          <Link className="lnk" href="/badges">badges catalog</Link> has one per benchmark and
          provider, and <Link className="lnk" href="/partners">partners</Link> carries the embed
          terms.
        </p>
        <Code>{`${SITE.url}/api/badge/ethereum-rpc/drpc`}</Code>
      </section>

      {/* VIII. Feeds and mirrors */}
      <section className="mt-16">
        <SectionHeader number="VIII" label="Feeds and mirrors" id="feeds" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="card-soft rounded-xl p-5">
            <h3 className="display text-base text-ink">Feeds</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-soft leading-relaxed">
              <li>
                <Link className="lnk font-mono text-[12px]" href="/rss.xml">/rss.xml</Link> and{" "}
                <Link className="lnk font-mono text-[12px]" href="/feed.json">/feed.json</Link> ·
                new benchmarks and reports.
              </li>
              <li>
                <Link className="lnk font-mono text-[12px]" href="/sitemap.xml">/sitemap.xml</Link> ·
                every indexable page with its last-modified date.
              </li>
            </ul>
          </div>
          <div className="card-soft rounded-xl p-5">
            <h3 className="display text-base text-ink">The same data elsewhere</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-soft leading-relaxed">
              {MIRRORS.map((m) => (
                <li key={m.href}>
                  <a className="lnk" href={withUtm(m.href)} rel="noopener" target="_blank">
                    {m.label}
                  </a>{" "}
                  · {m.body}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mt-16 card-soft rounded-xl p-6 sm:p-7">
        <h2 className="display text-lg text-ink">If something here is wrong</h2>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft leading-relaxed">
          A broken endpoint or a number that does not reproduce is worth a report, and both have a
          destination on the <Link className="lnk" href="/contact">contact page</Link>. Adding a
          benchmark of your own is <Link className="lnk" href="/contribute">contribute</Link>.
        </p>
      </section>
    </article>
  );
}
