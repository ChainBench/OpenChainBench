#!/usr/bin/env tsx
/**
 * `pnpm validate` — lint every benchmarks/*.yml file against the spec
 * schema. Exits non-zero on any error. Run in CI on every PR.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SpecSchema } from "../src/lib/spec-schema";

const ROOT = path.resolve(__dirname, "..");
const SPECS_DIR = path.join(ROOT, "benchmarks");

type Issue = { file: string; level: "error" | "warning"; message: string };

async function main() {
  const issues: Issue[] = [];

  const files = (await fs.readdir(SPECS_DIR)).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml")
  );

  if (files.length === 0) {
    console.log("No benchmark specs to validate (benchmarks/ is empty).");
    return;
  }

  const seenSlugs = new Map<string, string>();
  const seenNumbers = new Map<string, string>();

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
        message: `duplicate slug "${spec.slug}" — also defined in ${seenSlugs.get(spec.slug)}`,
      });
    } else {
      seenSlugs.set(spec.slug, f);
    }

    // Number must be unique
    if (seenNumbers.has(spec.number)) {
      issues.push({
        file: f,
        level: "error",
        message: `duplicate number "${spec.number}" — also used by ${seenNumbers.get(spec.number)}`,
      });
    } else {
      seenNumbers.set(spec.number, f);
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
