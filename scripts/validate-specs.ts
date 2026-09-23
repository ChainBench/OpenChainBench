#!/usr/bin/env tsx
/**
 * `pnpm validate`. lint every benchmarks/*.yml file against the spec
 * schema. Exits non-zero on any error. Run in CI on every PR.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SpecSchema } from "../src/lib/spec-schema";

const ROOT = path.resolve(__dirname, "..");
const SPECS_DIR = path.join(ROOT, "benchmarks");
const ANSWERS_DIR = path.join(ROOT, "answers");

type Issue = { file: string; level: "error" | "warning"; message: string };

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)(?::([a-z0-9_-]+))?(?::([a-z0-9_-]+))?\s*\}\}/gi;
const KNOWN_TOKENS = new Set(["p50", "p90", "p99", "mean", "success", "name", "best_name", "best_names", "best_p50", "worst_name", "worst_p50", "count", "ranked_count"]);

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
    ];
    lintPlaceholders(issues, f, templated, providerSlugs, chainValues, tierValues);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
