#!/usr/bin/env tsx
/**
 * `pnpm validate`. lint every benchmarks/*.yml file against the spec
 * schema. Exits non-zero on any error. Run in CI on every PR.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { SpecSchema } from "../src/lib/spec-schema";
import { COST_CELL_RE, costCell } from "../src/lib/cost-cell";

const ROOT = path.resolve(__dirname, "..");
const SPECS_DIR = path.join(ROOT, "benchmarks");
const ANSWERS_DIR = path.join(ROOT, "answers");

type Issue = { file: string; level: "error" | "warning"; message: string };

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)(?::([a-z0-9_-]+))?(?::([a-z0-9_-]+))?\s*\}\}/gi;
const KNOWN_TOKENS = new Set(["p50", "p90", "p99", "mean", "success", "name", "best_name", "best_names", "best_p50", "best_first", "worst_name", "worst_p50", "count", "ranked_count", "declared_count", "year"]);
/** Chain-scoped forms the renderer actually resolves: bench-template's
 *  CHAIN_TEMPLATE_RE, kept in step with it. */
const CHAIN_SCOPABLE = new Set(["best_name", "best_p50", "worst_name", "worst_p50"]);

/** Every `{{...}}` in `fields` names a known keyword, a provider slug of
 *  the bench for per-provider lookups, a declared chain value, or a
 *  declared access tier (`{{best_name:tier:keyed}}`, `{{count:tier:keyed}}`). */
function lintPlaceholders(
  issues: Issue[],
  file: string,
  fields: [string, string | undefined][],
  providerSlugs: Set<string>,
  chainValues: Set<string>,
  tierValues: Set<string> = new Set(),
) {
  for (const [name, text] of fields) {
    if (!text) continue;
    for (const m of text.matchAll(TOKEN_RE)) {
      const [whole, kw, a, b] = m;
      const k = kw.toLowerCase();
      if (!KNOWN_TOKENS.has(k)) {
        issues.push({ file, level: "error", message: `${name}: unknown placeholder ${whole}` });
      } else if (a === "chain") {
        if (!b || !chainValues.has(b.toLowerCase())) {
          issues.push({ file, level: "error", message: `${name}: ${whole} names a chain value the spec does not declare` });
        } else if (!CHAIN_SCOPABLE.has(k)) {
          // The same check the tier branch below has always had, and its
          // absence here is how {{count:chain:ethereum}} reached prod: the
          // chain value was declared, so this branch passed it, and
          // bench-template's CHAIN_TEMPLATE_RE then matched nothing and
          // left the token in the page as literal text. A renderer that
          // passes an unknown token through unchanged needs the gate to
          // name what it resolves, not only that the argument exists.
          // Per-chain row counts are not in bestPerChain / worstPerChain,
          // which is all the chain path has.
          issues.push({ file, level: "error", message: `${name}: ${whole} cannot be chain-scoped` });
        }
      } else if (a === "tier") {
        if (!b || !tierValues.has(b.toLowerCase())) {
          issues.push({ file, level: "error", message: `${name}: ${whole} names a tier the spec does not declare` });
        } else if (!["best_name", "best_p50", "worst_name", "worst_p50", "count"].includes(k)) {
          issues.push({ file, level: "error", message: `${name}: ${whole} cannot be tier-scoped` });
        }
      } else if (["p50", "p90", "p99", "mean", "success", "name"].includes(k)) {
        if (!a || !providerSlugs.has(a)) {
          issues.push({ file, level: "error", message: `${name}: ${whole} names no provider slug of this spec` });
        }
      } else if (a) {
        issues.push({ file, level: "error", message: `${name}: ${whole} takes no argument` });
      }
    }
  }
}

async function main() {
  const issues: Issue[] = [];
  const liveSlugs: { file: string; slug: string }[] = [];

  const files = (await fs.readdir(SPECS_DIR)).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml")
  );

  if (files.length === 0) {
    console.log("No benchmark specs to validate (benchmarks/ is empty).");
    return;
  }

  const seenSlugs = new Map<string, string>();
  const seenNumbers = new Map<string, string>();
  // Per spec, what its templates may reference; the answers pass below
  // resolves an answer's placeholders against its bench.
  const specRefs = new Map<string, { providers: Set<string>; chains: Set<string>; tiers: Set<string>; rpc: boolean }>();

  for (const f of files) {
    const filePath = path.join(SPECS_DIR, f);
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (e) {
      issues.push({
        file: f,
        level: "error",
        message: `YAML parse error: ${(e as Error).message}`,
      });
      continue;
    }

    const result = SpecSchema.safeParse(parsed);
    if (!result.success) {
      for (const err of result.error.issues) {
        issues.push({
          file: f,
          level: "error",
          message: `${err.path.join(".") || "(root)"}: ${err.message}`,
        });
      }
      continue;
    }

    const spec = result.data;

    // Slug must be unique
    if (seenSlugs.has(spec.slug)) {
      issues.push({
        file: f,
        level: "error",
        message: `duplicate slug "${spec.slug}". also defined in ${seenSlugs.get(spec.slug)}`,
      });
    } else {
      seenSlugs.set(spec.slug, f);
    }

    // Number must be unique
    if (seenNumbers.has(spec.number)) {
      issues.push({
        file: f,
        level: "error",
        message: `duplicate number "${spec.number}". also used by ${seenNumbers.get(spec.number)}`,
      });
    } else {
      seenNumbers.set(spec.number, f);
    }

    // RPC cluster copy: provider counts are live ({{count}}), never typed.
    // 332 typed counts contradicted the infobox on 5 pages (2026-09-19); a
    // page whose meta description, FAQPage JSON-LD and table disagree on
    // the cohort size is the failure this rule prevents.
    // Chain RPC pages only ("<chain>-rpc"): rpc-reliability's quorum rule
    // legitimately says "two providers".
    if (spec.slug.endsWith("-rpc") && spec.slug !== "mev-protect-rpc") {
      // Up to three words may sit between the number and the noun ("5
      // multi-chain no-key gateways", "three qualifying gateways").
      const typedCount =
        /(?<![\d.-])\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)(?:[- ](?!(?:seconds?|minutes?|hours?|ms|blocks?|slots?|chains?|behind|per|each|against|of|from|to|in|on|with|by|for)\b)[a-z-]+){0,3}[- ](provider|gateway|endpoint)s?\b/i;
      const fields: [string, string | undefined][] = [
        ["seo_description", spec.seo_description],
        ["subtitle", spec.subtitle],
        ["seo_intro", spec.seo_intro],
        ["abstract", spec.abstract],
        ...(spec.methodology ?? []).map((m, i) => [`methodology[${i}]`, m] as [string, string]),
        ...(spec.faq ?? []).map((q, i) => [`faq[${i}].a`, q.a] as [string, string]),
      ];
      for (const [name, text] of fields) {
        const m = text ? typedCount.exec(text) : null;
        if (m) {
          issues.push({
            file: f,
            level: "error",
            message: `${name}: typed provider count "${m[0]}"; use {{count}} (live cohort) instead`,
          });
        }
      }
    }

    // A panel metric that aggregates must carry its own selector.
    //
    // The loader splices the provider filter at the metric's FIRST brace and,
    // when there is none, appends `{provider="x"}` to the end. On a bare
    // metric that is correct. On an aggregation it lands outside the closing
    // paren, Prometheus answers `parse error: unexpected "{"`, and the panel
    // renders empty with nothing in a log to say why. Bench 282's break-even
    // panel shipped exactly that shape.
    for (const panel of spec.metric_panels ?? []) {
      const m = panel.metric.trim();
      if (/^[a-z_][a-z0-9_]*\s*(?:by\s*\([^)]*\)\s*)?\(/i.test(m) && !m.includes("{")) {
        issues.push({
          file: f,
          level: "error",
          message: `metric_panels.${panel.id}: "${m.slice(0, 60)}" aggregates but carries no selector; the loader appends the provider filter after the closing paren and Prometheus will not parse it. Add an empty {} inside the aggregation.`,
        });
      }
    }

    // Provider slugs unique within a spec
    const providerSlugs = new Set<string>();
    for (const p of spec.providers) {
      if (providerSlugs.has(p.slug)) {
        issues.push({
          file: f,
          level: "error",
          message: `duplicate provider slug "${p.slug}"`,
        });
      }
      providerSlugs.add(p.slug);
    }

    // Template placeholders resolve statically: a `{{p50:<slug>}}` names
    // a provider of this spec and a `{{best_name:chain:<x>}}` a declared
    // chain value. The renderer drops the clause of a known placeholder
    // it cannot resolve at request time (an endpoint down today), so a
    // typo would vanish silently on the page; it is caught here instead.
    const chainValues = new Set((spec.dimensions?.chain ?? []).map((c) => c.value.toLowerCase()));
    const tierValues = new Set((spec.dimensions?.tier ?? []).map((t) => t.value.toLowerCase()));
    const templated: [string, string | undefined][] = [
      ["subtitle", spec.subtitle],
      ["seo_title", spec.seo_title],
      ["seo_description", spec.seo_description],
      ["seo_intro", spec.seo_intro],
      ["abstract", spec.abstract],
      ["disclaimer", spec.disclaimer],
      ...(spec.findings ?? []).map((t, i) => [`findings[${i}]`, t] as [string, string]),
      ...(spec.methodology ?? []).map((t, i) => [`methodology[${i}]`, t] as [string, string]),
      ...(spec.faq ?? []).flatMap((q, i) => [[`faq[${i}].q`, q.q], [`faq[${i}].a`, q.a]] as [string, string][]),
      // These bodies were never linted, on any spec, and they are the field
      // most likely to carry a chain-scope mistake because they are the
      // field written per chain: {{count:chain:ethereum}} passed validate
      // and rendered as literal text on the Ethereum tab.
      ...(spec.per_chain_explainer ?? []).flatMap((e, i) => [
        [`per_chain_explainer[${i}].h2`, e.h2],
        [`per_chain_explainer[${i}].body`, e.body],
      ] as [string, string | undefined][]),
    ];
    lintPlaceholders(issues, f, templated, providerSlugs, chainValues, tierValues);

    // A provider row must read a series this bench claims to measure. Until
    // 2026-10-21, five `<chain>-official` rows (gravity, oasis x2, reya, vana)
    // queried provider="publicnode" because the harness registry filed the
    // chains' own endpoints under PublicNode's slug: sapphire.oasis.io,
    // emerald.oasis.io, rpc.vana.org, rpc.gravity.xyz and rpc.reya.network are
    // none of them PublicNode domains. The five pages read correctly, each row
    // named after its foundation and pinned to its own chain, but
    // rpc-capabilities averages provider="publicnode" across chains and so
    // credited PublicNode with 15 series of 183 that it does not operate.
    //
    // Which label names a row is a property of the bench, not of the label's
    // name: `asset` names the row on xstocks-peg (asset="tsla") and qualifies a
    // slice on perp-funding-cost-30d (asset="ETH"). So it is inferred, by
    // scoring each key on how many of its values relate to a declared slug, and
    // only the winning key is checked.
    {
      const fold = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      // Containment either way: a slug is often derived from the label rather
      // than equal to it (polymarket-sports composes venue="polymarket" with
      // category="sports"; pons-family is pad="ponsfamily.com"; chainstack-cold
      // reads its warm twin chainstack).
      const related = (a: string, b: string) =>
        a === b || (a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a)));
      const declared = [...providerSlugs].map(fold);

      const labelsOf = (p: (typeof spec.providers)[number]) => {
        const texts: string[] = [];
        const walk = (v: unknown) => {
          if (typeof v === "string") texts.push(v);
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") Object.values(v).forEach(walk);
        };
        walk(p.queries);
        const out = new Map<string, Set<string>>();
        for (const t of texts) {
          for (const m of t.matchAll(/(\w+)\s*=~?\s*"([^"]*)"/g)) {
            for (const alt of m[2].split("|")) {
              if (!alt) continue;
              if (!out.has(m[1])) out.set(m[1], new Set());
              out.get(m[1])!.add(alt);
            }
          }
        }
        return out;
      };

      const perProvider = spec.providers.map((p) => [p, labelsOf(p)] as const);

      // Score every key across the whole spec.
      const score = new Map<string, number>();
      const seen = new Map<string, Set<string>>();
      for (const [, labels] of perProvider) {
        for (const [k, vals] of labels) {
          if (!seen.has(k)) seen.set(k, new Set());
          for (const v of vals) seen.get(k)!.add(v);
        }
      }
      for (const [k, vals] of seen) {
        let n = 0;
        for (const v of vals) if (declared.some((d) => related(fold(v), d))) n++;
        score.set(k, n);
      }
      const key = [...score.entries()].sort((a, b) => b[1] - a[1])[0];

      if (key && key[1] > 0) {
        for (const [p, labels] of perProvider) {
          const vals = labels.get(key[0]);
          if (!vals || vals.size === 0) continue;
          const slug = fold(p.slug);
          const ok = [...vals].some(
            (v) => related(fold(v), slug) || declared.some((d) => related(fold(v), d)),
          );
          if (!ok) {
            issues.push({
              file: f,
              level: "error",
              message: `provider "${p.slug}" selects ${key[0]}=${[...vals].map((v) => `"${v}"`).join(", ")}, which this bench does not declare; the row would publish a series the bench makes no claim about (declared: ${[...providerSlugs].join(", ")})`,
            });
          }
        }
      }
    }

    specRefs.set(spec.slug, { providers: providerSlugs, chains: chainValues, tiers: tierValues, rpc: spec.slug.endsWith("-rpc") });
    if (spec.status === "live") liveSlugs.push({ file: f, slug: spec.slug });
  }

  // answers/*.yml render through the same template engine against the
  // bench they name, so the same static resolution applies: a chain value
  // the bench does not declare or a provider slug it does not have would
  // vanish from the page silently (the renderer drops the clause).
  // The typed-cohort rule covers the fields that carry {{count}} on the
  // same page: a hand-typed list of names next to a live count drifts on
  // the first cohort change (audit 2026-09-19, blocker 2).
  const answerFiles = (await fs.readdir(ANSWERS_DIR).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml")
  );
  for (const f of answerFiles) {
    const file = `../answers/${f}`;
    let ans: Record<string, unknown>;
    try {
      ans = yaml.load(await fs.readFile(path.join(ANSWERS_DIR, f), "utf8")) as Record<string, unknown>;
    } catch (e) {
      issues.push({ file, level: "error", message: `YAML parse error: ${(e as Error).message}` });
      continue;
    }
    if (!ans || typeof ans !== "object") continue;
    const benchSlug = typeof ans.benchmark === "string" ? ans.benchmark : "";
    const refs = specRefs.get(benchSlug);
    if (!refs) continue; // a bench outside this checkout: the answer is filtered out at load time
    const str = (k: string) => (typeof ans[k] === "string" ? (ans[k] as string) : undefined);
    const faq = Array.isArray(ans.faq) ? (ans.faq as { q?: string; a?: string }[]) : [];
    const templated: [string, string | undefined][] = [
      ["short_answer", str("short_answer")],
      ["seo_title", str("seo_title")],
      ["seo_description", str("seo_description")],
      ["intro", str("intro")],
      ["methodology", str("methodology")],
      ["expert_take", str("expert_take")],
      ...faq.flatMap((q, i) => [[`faq[${i}].q`, q.q], [`faq[${i}].a`, q.a]] as [string, string | undefined][]),
    ];
    lintPlaceholders(issues, file, templated, refs.providers, refs.chains, refs.tiers);
    // "{{count}} bridges (Mobula, Relay, LI.FI, deBridge, ...)": a live
    // count followed by a typed enumeration of four or more names.
    const typedCohort = /\{\{\s*count\s*\}\}\s+\w+\s*\((?:[^()]*,){3,}[^()]*\)/;
    for (const [name, text] of templated) {
      const m = text ? typedCohort.exec(text) : null;
      if (m) {
        issues.push({ file, level: "error", message: `${name}: {{count}} followed by a typed cohort list "${m[0].slice(0, 60)}"; drop the list, the count is live` });
      }
    }
  }

  // A live spec with no entry in the published map falls back to the
  // 2025-01-01 floor, and every JSON-LD datePublished, the citation date
  // and the Dataset temporalCoverage then claim a history the series does
  // not have. Regenerating is one command; forgetting it is silent.
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "src/data/bench-published.json"), "utf8");
    const published = JSON.parse(raw) as Record<string, string>;
    for (const { file, slug } of liveSlugs) {
      if (!published[slug]) {
        issues.push({
          file,
          level: "error",
          message: `slug "${slug}" is missing from src/data/bench-published.json, so every datePublished, the citation date and the Dataset temporalCoverage would fall back to 2025-01-01; run \`node scripts/generate-bench-published.mjs\` and commit the result`,
        });
      }
    }
  } catch {
    // No map in this checkout: the dates fall back everywhere, which is a
    // repo-shape problem rather than a spec problem.
  }

  await checkCostCurveFreshness(issues);
  await checkWalletCostCurveFreshness(issues);

  if (issues.length === 0) {
    console.log(`✓ ${files.length} spec${files.length === 1 ? "" : "s"} valid.`);
    return;
  }

  for (const i of issues) {
    const tag = i.level === "error" ? "✗" : "⚠";
    console.error(`${tag} benchmarks/${i.file}: ${i.message}`);
  }
  const errors = issues.filter((i) => i.level === "error").length;
  if (errors > 0) {
    console.error(`\n${errors} error${errors === 1 ? "" : "s"}.`);
    process.exit(1);
  }
}

/**
 * Bench 282 ships a committed cost curve so the page can offer a slider over
 * any request count instead of the three volumes the gauges publish. The
 * curve is generated from the pricing catalogue, and nothing at runtime
 * notices when the catalogue moves and the curve does not: the slider would
 * keep quoting last month's prices under this month's "as of" date, which is
 * the one thing a pricing bench cannot do.
 *
 * So the artifact records which catalogue it was built from, and this
 * compares that against the catalogue on disk. Regenerate with:
 *
 *   cd harnesses/rpc-cost
 *   RPC_COST_EMIT_CURVES=../../src/data/rpc-cost-curves.json go run ./cmd/script
 */
async function checkCostCurveFreshness(issues: Issue[]) {
  const CURVE = "src/data/rpc-cost-curves.json";
  const CATALOGUE = "harnesses/rpc-cost/pricing/catalogue.yml";
  const REGEN = `regenerate it: cd harnesses/rpc-cost && RPC_COST_EMIT_CURVES=../../${CURVE} go run ./cmd/script`;

  let curve: { schema?: number; catalogueVersion?: number; catalogueAsOf?: string };
  let catalogue: { version?: number; as_of?: string };
  try {
    curve = JSON.parse(await fs.readFile(path.join(ROOT, CURVE), "utf8"));
    catalogue = yaml.load(await fs.readFile(path.join(ROOT, CATALOGUE), "utf8")) as typeof catalogue;
  } catch {
    // Neither file present is a repo-shape problem, not a spec problem. The
    // reader already renders no slider rather than a wrong one.
    return;
  }

  // Kept in step with `RPC_COST_CURVE_SCHEMA` in src/lib/rpc-cost-curve.ts and
  // `curveSchema` in harnesses/rpc-cost/cmd/script/curve.go. A mismatch makes
  // the reader return null, so the slider disappears with no other signal.
  const EXPECTED_SCHEMA = 1;
  if (curve.schema !== EXPECTED_SCHEMA) {
    issues.push({
      file: "rpc-cost.yml",
      level: "error",
      message: `${CURVE} is schema ${curve.schema}, the reader expects ${EXPECTED_SCHEMA}; the slider renders nothing at all until they agree. ${REGEN}`,
    });
  }
  if (curve.catalogueVersion !== catalogue.version || curve.catalogueAsOf !== catalogue.as_of) {
    issues.push({
      file: "rpc-cost.yml",
      level: "error",
      message: `${CURVE} was built from catalogue v${curve.catalogueVersion} as of ${curve.catalogueAsOf}, and ${CATALOGUE} is now v${catalogue.version} as of ${catalogue.as_of}; the slider would quote the old prices. ${REGEN}`,
    });
  }
}

/**
 * The wallet-cost curve records the SHA256 of the catalogue bytes it was
 * built from, not just a version and a date: bench 282's check only fires
 * when someone remembers to bump `as_of`, and a price edited without that
 * bump would ship a slider quoting the old figure. Any byte changed in the
 * catalogue without regenerating the curve fails here. Regenerate with:
 *
 *   cd harnesses/wallet-cost
 *   WALLET_COST_EMIT_CURVES=../../src/data/wallet-cost-curves.json go run ./cmd/script
 */
type CostBench = { slug: string; harness: string; env: string };

/** Benches 309, 310 and 312 share the catalogue -> curve -> calculator design. */
const COST_BENCHES: CostBench[] = [
  { slug: "wallet-cost", harness: "harnesses/wallet-cost", env: "WALLET_COST" },
  { slug: "server-wallet-cost", harness: "harnesses/server-wallet-cost", env: "SERVER_WALLET_COST" },
  { slug: "paymaster-cost", harness: "harnesses/paymaster-cost", env: "PAYMASTER_COST" },
];

async function checkWalletCostCurveFreshness(issues: Issue[]) {
  for (const b of COST_BENCHES) await checkCostBenchCurve(issues, b);
}

async function checkCostBenchCurve(issues: Issue[], b: CostBench) {
  const CURVE = `src/data/${b.slug}-curves.json`;
  const CATALOGUE = `${b.harness}/pricing/catalogue.yml`;
  const REGEN = `regenerate it: cd ${b.harness} && ${b.env}_EMIT_CURVES=../../${CURVE} go run ./cmd/script`;
  let curve: { schema?: number; catalogueSha256?: string };
  let raw: Buffer;
  try {
    curve = JSON.parse(await fs.readFile(path.join(ROOT, CURVE), "utf8"));
    raw = await fs.readFile(path.join(ROOT, CATALOGUE));
  } catch {
    return;
  }
  // Kept in step with WALLET_COST_CURVE_SCHEMA in src/lib/wallet-cost-curve.ts
  // and Schema in harnesses/wallet-cost/cmd/script/curve.go.
  if (curve.schema !== 1) {
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `${CURVE} is schema ${curve.schema}, the reader expects 1; the calculator renders nothing until they agree. ${REGEN}`,
    });
  }
  const sha = createHash("sha256").update(raw).digest("hex");
  if (curve.catalogueSha256 !== sha) {
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `${CURVE} was built from a different ${CATALOGUE} (sha256 ${String(curve.catalogueSha256).slice(0, 12)} vs ${sha.slice(0, 12)}); the calculator would quote prices the catalogue no longer holds. ${REGEN}`,
    });
    return;
  }
  // The independent scorer, a second implementation of the billing model in
  // another language, re-prices every curve point and a sample of random app
  // sizes. The full run (30,000 sizes per cell) is the harness README's;
  // 2,000 here keeps validate fast and still lands in every segment.
  const SCORER = `${b.harness}/verify/scorer.mjs`;
  const tableFile = path.join(os.tmpdir(), `${b.slug}-table-${process.pid}.json`);
  try {
    execFileSync(process.execPath, [path.join(ROOT, SCORER), path.join(ROOT, CATALOGUE), path.join(ROOT, CURVE), "2000"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, [`${b.env}_TABLE`]: tableFile },
    });
  } catch (e) {
    const out = String((e as { stdout?: Buffer }).stdout ?? "").slice(0, 600);
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `${SCORER} disagrees with ${CURVE}: ${out}`,
    });
    return;
  }

  // The prose quotes bills and prices typed by hand (findings, FAQ,
  // methodology). Every dollar figure in it must be either a bill the model
  // produces at a published volume or a fee or rate in the catalogue, so a
  // price correction that moves a quoted bill fails here instead of leaving
  // the FAQPage block naming last month's figure (SEO audit 2026-10-29).
  let table: Record<string, number | null>;
  try {
    table = JSON.parse(await fs.readFile(tableFile, "utf8"));
    await fs.unlink(tableFile);
  } catch {
    return;
  }
  const cents = (v: number) => Math.round(v * 100);
  const allowed = new Set<number>();
  for (const v of Object.values(table)) if (typeof v === "number") allowed.add(cents(v));
  const cat = yaml.load(raw.toString("utf8")) as {
    providers?: { plans?: { monthly_usd?: number | null; annual_usd?: number; tiers?: Record<string, { rate?: number }[]> }[] }[];
  };
  for (const p of cat.providers ?? []) {
    for (const pl of p.plans ?? []) {
      if (typeof pl.monthly_usd === "number") allowed.add(cents(pl.monthly_usd));
      if (typeof pl.annual_usd === "number") {
        allowed.add(cents(pl.annual_usd));
        allowed.add(cents(pl.annual_usd / 12));
      }
      for (const tiers of Object.values(pl.tiers ?? {})) {
        for (const tier of tiers) if (typeof tier.rate === "number") allowed.add(Math.round(tier.rate * 1e6) / 1e4);
      }
    }
  }
  // Bench 312 states the gas beside every bill: one operation's gas on each
  // chain, and the gas of a published volume, are the scenario's own figures.
  for (const sc of (cat as { scenarios?: { gas_usd_per_tx?: number; sizes?: { x: number }[] }[] }).scenarios ?? []) {
    const g = sc.gas_usd_per_tx;
    if (typeof g !== "number" || g <= 0) continue;
    allowed.add(cents(g));
    allowed.add(Math.round(g * 1e6) / 1e4);
    for (const z of sc.sizes ?? []) allowed.add(cents(g * z.x));
  }
  const spec = yaml.load(await fs.readFile(path.join(ROOT, `benchmarks/${b.slug}.yml`), "utf8")) as Record<string, unknown>;
  const prose: string[] = [];
  for (const k of ["findings", "methodology"]) for (const s of (spec[k] as string[]) ?? []) prose.push(s);
  for (const f of (spec.faq as { q: string; a: string }[]) ?? []) prose.push(f.q, f.a);
  for (const k of ["seo_intro", "abstract", "disclaimer", "subtitle", "seo_description"]) {
    if (typeof spec[k] === "string") prose.push(spec[k] as string);
  }
  // {{cell:<kind>:<size>:<field>}} must resolve against this bench's curve.
  const badCells = new Set<string>();
  for (const s of prose) {
    for (const m of s.matchAll(COST_CELL_RE)) {
      if (costCell(b.slug, m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase()) === null) badCells.add(m[0]);
    }
  }
  if (badCells.size > 0) {
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `cell placeholders that name no profile, size, field or vendor of the curve: ${[...badCells].join(", ")}`,
    });
  }
  // A winner, a rank or a spread in the findings or the FAQ comes from the
  // curve, not from the keyboard: "Reown is cheapest" carries no dollar
  // figure for the check below, and "Dynamic leads all three at $724"
  // outlived the price that made it true (SEO audit 2026-10-30).
  const claims: string[] = [...((spec.findings as string[]) ?? []), ...((spec.faq as { a: string }[]) ?? []).map((f) => f.a)];
  const WINNER =
    /\b(?:is|are) (?:the )?(?:cheapest|dearest|next dearest)\b|\bleads?\b|\b\d+(?:\.\d+)?x\b|\b(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;
  const typed = new Set<string>();
  for (const c of claims) {
    for (const sentence of c.split(/(?<=[.;?!])\s+/)) {
      if (!WINNER.test(sentence)) continue;
      if (/\{\{\s*cell:/i.test(sentence)) continue;
      typed.add(sentence.slice(0, 110));
    }
  }
  if (typed.size > 0) {
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `a winner, rank or spread typed by hand in the findings or FAQ; read it from the curve with {{cell:<kind>:<size>:<field>}}: ${[...typed].map((s) => `"${s}"`).join("; ")}`,
    });
  }
  const bad = new Set<string>();
  for (const s of prose) {
    // "$1M of monthly transaction volume" is a threshold, not a price: a
    // figure with a magnitude suffix is skipped.
    for (const m of s.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(?![\d.,]*[kMB])/g)) {
      const v = Number(m[1].replace(/,/g, ""));
      // Rates carry fractions of a cent ($0.005); compare in hundredths of a
      // cent for those, in cents for everything else.
      const ok = allowed.has(cents(v)) || allowed.has(Math.round(v * 1e6) / 1e4);
      if (!ok) bad.add(m[0]);
    }
  }
  if (bad.size > 0) {
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `dollar figures in the prose that are neither a bill at a published volume nor a catalogue fee or rate: ${[...bad].join(", ")}. Re-read the prose against the regenerated curve.`,
    });
  }

  // A figure must also belong to the vendor the sentence gives it to. The
  // check above let "Dynamic at $724" stand after Dynamic's bill moved to
  // $4,999, because $724 was still some other number in the model (audit
  // 2026-10-30). The nearest vendor named before a figure, in the same
  // sentence, owns it.
  const named = (cat as { providers?: { slug: string; name: string }[] }).providers ?? [];
  const perVendor = new Map<string, Set<number>>();
  for (const [key, v] of Object.entries(table)) {
    const slug = key.split("|")[2];
    if (!slug || typeof v !== "number") continue;
    if (!perVendor.has(slug)) perVendor.set(slug, new Set());
    perVendor.get(slug)!.add(cents(v));
  }
  for (const p of (cat.providers ?? []) as { slug?: string; plans?: { monthly_usd?: number | null; annual_usd?: number; tiers?: Record<string, { rate?: number }[]> }[] }[]) {
    if (!p.slug) continue;
    const s = perVendor.get(p.slug) ?? new Set<number>();
    for (const pl of p.plans ?? []) {
      if (typeof pl.monthly_usd === "number") s.add(cents(pl.monthly_usd));
      if (typeof pl.annual_usd === "number") (s.add(cents(pl.annual_usd)), s.add(cents(pl.annual_usd / 12)));
      for (const tiers of Object.values(pl.tiers ?? {})) for (const tier of tiers) if (typeof tier.rate === "number") s.add(Math.round(tier.rate * 1e6) / 1e4);
    }
    // The other reading of an ambiguous page ("$0.005 in its FAQ") is quoted
    // on purpose; it is allowed when the catalogue's note for that vendor
    // records it.
    const notes = [(p as { note?: string }).note ?? "", ...(p.plans ?? []).map((pl) => (pl as { note?: string }).note ?? "")].join(" ");
    for (const m of notes.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
      const v = Number(m[1].replace(/,/g, ""));
      s.add(cents(v));
      s.add(Math.round(v * 1e6) / 1e4);
    }
    perVendor.set(p.slug, s);
  }
  // "Lit Protocol" is written "Lit", "Coinbase CDP" sometimes "CDP".
  const patterns = named.flatMap((p) =>
    [...new Set([p.name, p.name.split(" ")[0]])].map((n) => ({ slug: p.slug, re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g") })),
  );
  const misattributed = new Set<string>();
  for (const s of prose) {
    for (const sentence of s.split(/(?<=[.;?!])\s+/)) {
      for (const m of sentence.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(?![\d.,]*[kMB])/g)) {
        const at = m.index ?? 0;
        let owner: string | null = null;
        let ownerAt = -1;
        // "$438 at most at thirdweb": a vendor right after the figure owns it.
        const after = sentence.slice(at + m[0].length, at + m[0].length + 30);
        for (const { slug, re } of patterns) {
          const hit = new RegExp(`^[^,;$]*?\\bat\\s+${re.source}`).exec(after);
          if (hit) ((owner = slug), (ownerAt = at));
        }
        if (!owner) {
          for (const { slug, re } of patterns) {
            for (const n of sentence.slice(0, at).matchAll(re)) {
              if ((n.index ?? -1) > ownerAt) ((ownerAt = n.index ?? -1), (owner = slug));
            }
          }
        }
        if (!owner || !perVendor.has(owner)) continue;
        const v = Number(m[1].replace(/,/g, ""));
        const own = perVendor.get(owner)!;
        if (!own.has(cents(v)) && !own.has(Math.round(v * 1e6) / 1e4)) {
          misattributed.add(`${m[0]} after ${owner} ("${sentence.slice(Math.max(0, ownerAt), at + m[0].length).slice(0, 90)}")`);
        }
      }
    }
  }
  if (misattributed.size > 0) {
    issues.push({
      file: `${b.slug}.yml`,
      level: "error",
      message: `dollar figures given to a vendor whose bills and prices do not include them: ${[...misattributed].join("; ")}. Re-read the prose against the regenerated curve.`,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
