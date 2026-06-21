import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { getBenchmarksSafe } from "@/data/benchmarks";
import { mcpPageLd } from "@/lib/hub-jsonld";
import { safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

const MCP_URL = "https://openchainbench.com/api/mcp/mcp";

const CLAUDE_DESKTOP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      openchainbench: {
        url: MCP_URL,
      },
    },
  },
  null,
  2,
);

const CURSOR_CONFIG = JSON.stringify(
  {
    mcpServers: {
      openchainbench: {
        url: MCP_URL,
      },
    },
  },
  null,
  2,
);

const CURL_EXAMPLE = `curl -s -X POST ${MCP_URL} \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_benchmark","arguments":{"slug":"aggregator-head-lag","chain":"base"}}}'`;

export const metadata: Metadata = pageMetadata({
  path: "/mcp",
  title: "MCP server",
  description:
    "Connect Claude Desktop, Cursor, ChatGPT or any MCP-capable agent to OpenChainBench. Live crypto-infra benchmarks become a first-class tool for your AI assistant.",
});

export const revalidate = 300;

export default async function McpPage() {
  const benches = (await getBenchmarksSafe()).filter((b) => b.editorialStatus === "live");

  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 pt-12 pb-16">
      {mcpPageLd().map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}
      <p className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink-faint font-medium">
        Integration
      </p>
      <h1 className="mt-3 display text-3xl sm:text-4xl md:text-5xl tracking-tight">
        Use OpenChainBench from your AI assistant
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-ink-soft leading-snug">
        OpenChainBench ships an MCP server. Point Claude Desktop, Cursor,
        ChatGPT, or any{" "}
        <a
          href="https://modelcontextprotocol.io"
          className="lnk"
          rel="noopener"
        >
          MCP-capable client
        </a>{" "}
        at one URL and live crypto-infra benchmarks become a first-class
        tool for your model.
      </p>

      {/* The URL */}
      <section className="mt-10 border border-ink/80 bg-paper-soft/50 p-5">
        <p className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint font-medium">
          Server URL
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <code className="font-mono text-sm sm:text-base text-ink break-all">
            {MCP_URL}
          </code>
          <CopyButton value={MCP_URL} label="Copy URL" />
        </div>
        <p className="mt-3 text-[11px] text-ink-muted">
          Transport: streamable HTTP · Auth: none · Rate limit: 60 req/min/IP
        </p>
      </section>

      {/* Install in Claude Desktop */}
      <section className="mt-12">
        <header className="flex items-baseline gap-3">
          <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
            I
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            Install in Claude Desktop
          </h2>
        </header>
        <p className="mt-4 text-sm text-ink-soft leading-relaxed">
          Add this block to{" "}
          <code className="font-mono text-[0.92em] text-ink break-all">
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </code>{" "}
          (macOS) or the equivalent on your OS, then restart the app.
        </p>
        <CodeBlock value={CLAUDE_DESKTOP_CONFIG} />
        <p className="mt-3 text-xs text-ink-muted leading-relaxed">
          Once connected, the three tools appear under the 🔌 icon in the
          chat input. Ask Claude{" "}
          <em>“which crypto aggregator is fastest on Base today?”</em>{" "}
          and it will call <code className="font-mono text-[0.92em]">get_benchmark</code>{" "}
          and cite the live number.
        </p>
      </section>

      {/* Install in Cursor */}
      <section className="mt-10">
        <header className="flex items-baseline gap-3">
          <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
            II
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            Install in Cursor
          </h2>
        </header>
        <p className="mt-4 text-sm text-ink-soft leading-relaxed">
          Settings → MCP → Add server → paste the URL above. Or drop the
          same JSON block into{" "}
          <code className="font-mono text-[0.92em] text-ink">
            ~/.cursor/mcp.json
          </code>
          :
        </p>
        <CodeBlock value={CURSOR_CONFIG} />
      </section>

      {/* Other clients */}
      <section className="mt-10">
        <header className="flex items-baseline gap-3">
          <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
            III
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            Any other MCP client
          </h2>
        </header>
        <p className="mt-4 text-sm text-ink-soft leading-relaxed">
          Continue, Zed, Cline, Goose, custom agents on the{" "}
          <a href="https://github.com/modelcontextprotocol" className="lnk" rel="noopener">
            MCP SDKs
          </a>
          : all accept the same URL with the streamable-HTTP transport. SSE
          is intentionally disabled. Anything else, raw curl works:
        </p>
        <CodeBlock value={CURL_EXAMPLE} />
      </section>

      {/* What's exposed */}
      <section className="mt-14 border-t border-rule pt-8">
        <header className="flex items-baseline gap-3">
          <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
            Surface
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            What&apos;s exposed
          </h2>
        </header>

        <div className="mt-6 grid gap-px bg-rule border border-rule sm:grid-cols-2">
          <Tile
            tag="Tool"
            title="list_benchmarks()"
            desc="Flat index of every live benchmark with current value, leader, category, and citation URL. The discovery call your agent runs first."
          />
          <Tile
            tag="Tool"
            title="get_benchmark(slug, chain?, region?)"
            desc="Full detail for one bench: rankings, sparkline, headline, paste-ready citation quote, methodology. Filter by chain or region when the spec declares them."
          />
          <Tile
            tag="Tool"
            title="query_prom(query, windowSec?, steps?)"
            desc="Direct PromQL passthrough, scoped to published benchmark metric namespaces. Allowlist enforced: wallet inventories and operational metrics are refused."
          />
          <Tile
            tag="Resource"
            title="openchainbench://benchmark/{slug}"
            desc={`${benches.length} benchmarks each exposed as an MCP resource (Markdown + JSON in the same read). Pin one into your agent's context as a long-lived document instead of re-fetching every turn.`}
          />
        </div>
      </section>

      {/* Example questions */}
      <section className="mt-14 border-t border-rule pt-8">
        <header className="flex items-baseline gap-3">
          <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
            Examples
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            Ask your agent
          </h2>
        </header>
        <ul className="mt-6 space-y-3 text-sm text-ink-soft leading-relaxed">
          <li>
            <span className="text-ink-muted">·</span>{" "}
            <em>Which crypto data aggregator is fastest on Base today?</em>
          </li>
          <li>
            <span className="text-ink-muted">·</span>{" "}
            <em>How much does it cost to bridge $300 USDC from Solana to Arbitrum?</em>
          </li>
          <li>
            <span className="text-ink-muted">·</span>{" "}
            <em>Plot bridge fees over the last 24 hours.</em>
          </li>
          <li>
            <span className="text-ink-muted">·</span>{" "}
            <em>Compare Mobula and GeckoTerminal on network coverage.</em>
          </li>
          <li>
            <span className="text-ink-muted">·</span>{" "}
            <em>Cite the latest finality lag for BNB Chain in a paragraph I can paste.</em>
          </li>
        </ul>
      </section>

      {/* Safety + open source */}
      <section className="mt-14 border-t border-rule pt-8">
        <header className="flex items-baseline gap-3">
          <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
            Safety
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            Open by design
          </h2>
        </header>
        <p className="mt-4 max-w-2xl text-sm text-ink-soft leading-relaxed break-words">
          The server is read-only. There are no admin actions, no mutating
          tools, no upstream secrets reachable through the wire. PromQL
          queries are scoped to the metric namespaces we publish, so the
          public endpoint can&apos;t be used to walk the underlying Prometheus.
          Rate limits, body caps, batch rejection and SSE disable are
          enforced at the route. Source is on{" "}
          <a
            href="https://github.com/ChainBench/OpenChainBench/blob/main/src/app/api/mcp/%5Btransport%5D/route.ts"
            className="lnk break-all"
            rel="noopener"
          >
            GitHub
          </a>
          .
        </p>
      </section>

      <p className="mt-14 text-xs text-ink-muted leading-relaxed">
        Trouble?{" "}
        <Link href="/contribute#ai-assist" className="lnk">
          Drop a note on /contribute
        </Link>{" "}
        or open an issue. We watch the channel.
      </p>
    </article>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <div className="mt-4 relative">
      <pre className="overflow-x-auto border border-ink/20 bg-ink/5 px-4 py-3 font-mono text-[11px] sm:text-xs text-ink leading-relaxed">
        <code>{value}</code>
      </pre>
      <div className="mt-2 flex justify-end">
        <CopyButton value={value} label="Copy" />
      </div>
    </div>
  );
}

function Tile({
  tag,
  title,
  desc,
}: {
  tag: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="bg-paper p-5 flex flex-col gap-2">
      <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
        {tag}
      </p>
      <p className="font-mono text-sm text-ink leading-tight">{title}</p>
      <p className="text-sm text-ink-soft leading-relaxed flex-1">{desc}</p>
    </div>
  );
}
