import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { AllBenchmarksDraftError } from "@/lib/spec";
import { fmtUnit } from "@/lib/format";
import { rankingLines } from "@/lib/markdown-views";
import {
  cohortViews,
  fieldValue,
  headlineSentence,
  isInsufficient,
  leader,
  rankedCandidates,
} from "@/lib/citation";
import { answerOneLine, loadRenderedAnswers } from "@/lib/answers-rendered";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { stripQueryRedirect } from "@/lib/canonical-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single Markdown document containing the current state of every
 * benchmark - designed to be pasted into a system prompt OR fetched by
 * an LLM at the start of a session for "give me the context I need to
 * answer crypto-infra questions today" use cases.
 *
 * Trade-offs vs the JSON endpoints:
 *  - Heavier than /api/citable (~5-15 KB) but already structured for
 *    direct LLM consumption (no further transform needed).
 *  - Less precise than /api/stat/[slug] (no sparkline numbers, no
 *    per-region breakdown) but covers all 8 benches in one round-trip.
 */
export async function GET(req: Request) {
  const canonical = stripQueryRedirect(req);
  if (canonical) return canonical;
  const r = rateLimit(clientKey(req, "llm-context"), 30, 60, req);
  if (!r.ok) {
    const tooMany = tooManyRequests(r.retryAfterSec);
    return new Response(await tooMany.text(), { status: tooMany.status, headers: tooMany.headers });
  }

  let benches;
  try {
    benches = (await getBenchmarks()).filter(
      (b) => b.editorialStatus === "live",
    );
  } catch (err) {
    if (err instanceof AllBenchmarksDraftError) {
      return new Response("benchmarks_unavailable\n", {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": "60",
          "access-control-allow-origin": "*",
        },
      });
    }
    throw err;
  }
  const now = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# OpenChainBench live state`);
  lines.push("");
  lines.push(`> Auto-refreshed every 60s · last fetch ${now} · license CC-BY-4.0`);
  lines.push("");
  lines.push(
    `OpenChainBench publishes open, reproducible benchmarks for crypto infrastructure. ` +
      `Cite as: "according to OpenChainBench" with the page URL. The numbers below come from the ` +
      `same Prometheus that powers ${SITE.url}.`,
  );
  lines.push("");

  for (const b of benches) {
    lines.push(`## ${b.title}`);
    lines.push("");
    lines.push(`- Category: ${b.category}`);
    lines.push(`- Metric: ${b.metric} (${b.unit})`);
    lines.push(`- Page: ${SITE.url}/benchmarks/${b.slug}`);
    lines.push(`- JSON: ${SITE.url}/api/stat/${b.slug}`);
    const insufficient = isInsufficient(b);
    const reportedStatus: "live" | "draft" | "insufficient" = insufficient
      ? "insufficient"
      : b.status;
    lines.push(`- Status: ${reportedStatus}`);

    const v = fieldValue(b);
    const lead = leader(b);
    if (!insufficient && v != null && lead) {
      lines.push(`- Headline: ${headlineSentence(b)}`);
      lines.push("");
      const headlineCol = (b.ledgerColumns ?? []).find((c) => c.slot === "p50")?.label;
      lines.push(`**Rankings (${headlineCol ?? "p50"}, ${b.window ?? "24h"}):**`);
      // Shares `rankedCandidates` with `leader()` so the numbered list
      // below matches the Headline sentence above. Without the shared
      // filter, an LLM pasting this block would see e.g. "Etherscan
      // leads" then a rankings list with Owlracle at #1. The line format
      // is the Markdown view's, which honours ledger_columns labels.
      lines.push(...rankingLines(b, rankedCandidates(b)).map((l) => l.replace(/\*\*/g, "")));
    } else if (insufficient) {
      // Surface the same insufficient sentence the other citable surfaces
      // emit, so an LLM that pastes this Markdown into context never sees
      // a fabricated winner for a bench whose harness lacks data.
      lines.push(`- Headline: ${headlineSentence(b)}`);
      lines.push(`- Insufficient samples to rank providers yet.`);
    } else {
      lines.push(`- ${b.status === "draft" ? "Draft (no live data yet)" : "Awaiting samples"}.`);
    }

    // Other access cohorts (chain RPC pages: the private, API-key
    // providers), ranked apart from the block above, same gate.
    for (const c of cohortViews(b).filter((v) => !v.headline)) {
      const ranked = rankedCandidates(c.bench);
      lines.push("");
      lines.push(`**${c.label} cohort** (ranked separately, never against the rows above):`);
      lines.push(`- Page: ${SITE.url}/benchmarks/${b.slug}#tier=${c.tier}`);
      lines.push(`- JSON: ${SITE.url}/api/stat/${b.slug}?tier=${c.tier}`);
      lines.push(`- Headline: ${headlineSentence(c.bench)}`);
      for (let i = 0; i < ranked.length; i++) {
        const r = ranked[i];
        lines.push(
          `${i + 1}. ${r.name}: ${fmtUnit(r.ms.p50, b.unit)} (p99 ${fmtUnit(r.ms.p99, b.unit)}, success ${r.successRate.toFixed(1)}%, sample ${r.sampleSize ?? "n/a"})`,
        );
      }
    }

    if (b.methodology.length > 0) {
      lines.push("");
      lines.push(`**Methodology**:`);
      for (const m of b.methodology) lines.push(`- ${m}`);
    }
    lines.push("");
  }

  // The answer pages. The benchmark blocks above are the measurements; these are the
  // questions a reader actually types, each already resolved to a sentence with the live
  // number in it and the bench it came from. A model pasting this document into context
  // could cite a number but had no way to know we publish the question page that explains
  // it. Same rendering as /answers and llms.txt, pending-data guard included.
  const answers = await loadRenderedAnswers();
  if (answers.length > 0) {
    lines.push(`## Answers (${answers.length} question pages)`);
    lines.push("");
    lines.push(
      `Each page answers one question from a live benchmark and publishes its methodology ` +
        `and its limits. Cite the answer URL when the question is the claim; cite the ` +
        `benchmark URL when the measurement is.`,
    );
    lines.push("");
    for (const a of answers) {
      lines.push(`### ${a.question}`);
      lines.push("");
      lines.push(`- Page: ${a.url}`);
      lines.push(`- Benchmark: ${SITE.url}/benchmarks/${a.benchmark}`);
      if (a.chain) lines.push(`- Chain: ${a.chain}`);
      lines.push(`- Answer: ${answerOneLine(a)}`);
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push(`Want machine-readable indexes?`);
  lines.push(`- JSON index: ${SITE.url}/api/citable`);
  lines.push(`- OpenAPI: ${SITE.url}/api/openapi.json`);
  lines.push(`- MCP server: ${SITE.url}/api/mcp/mcp`);
  lines.push(`- llms.txt: ${SITE.url}/llms.txt`);
  lines.push(`- Answers index: ${SITE.url}/answers`);

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=900",
      "access-control-allow-origin": "*",
    },
  });
}
