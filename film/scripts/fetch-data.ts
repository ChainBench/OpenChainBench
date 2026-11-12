/**
 * Pulls everything the film says from the live site, and writes src/data.ts.
 *
 * Run it, commit the result, render. The generated module is committed on
 * purpose: a render has to be reproducible months later, and the API it came
 * from keeps moving. Every figure on screen therefore has a date attached and
 * a known provenance, instead of being whatever the API said the day someone
 * happened to hit render.
 *
 *   pnpm --dir film data     # refresh src/data.ts and public/logos
 *
 * The editorial choices live in ACTS below: which bench carries which category
 * and how its measurement should be read. Everything else, names, values,
 * units, ranks, category copy, comes off the wire.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "../../src/lib/categories";
import { logoPath } from "../../src/lib/logo-manifest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILM = path.resolve(HERE, "..");
const REPO = path.resolve(FILM, "..");
const API = "https://openchainbench.com/api";

/**
 * How each act reads its measurement. The `shape` is the reason this film
 * stopped being six identical bar charts: a latency bench and a throughput
 * bench are not the same claim and should not be the same picture.
 *
 *   lag    arrival times on one shared clock
 *   volume accumulation into columns
 *   fee    subtraction from a transfer
 *   tempo  the measurement played back as rhythm
 */
const ACTS = [
  {
    slug: "aggregator-head-lag",
    category: "Aggregators",
    shape: "lag",
    claim: "A block lands. Who says so first?",
    metric: "Head lag",
  },
  {
    slug: "terminal-swap-transactions",
    category: "Trading",
    shape: "volume",
    claim: "One month of swaps, routed",
    metric: "Swaps routed",
  },
  {
    slug: "bridge-fee",
    category: "Bridges",
    shape: "fee",
    claim: "Send $10,000 across",
    metric: "Fee taken",
  },
  {
    slug: "l2-block-time",
    category: "Blockchains",
    shape: "tempo",
    claim: "Four seconds of blocks",
    metric: "Block time",
  },
] as const;

const MAX_FIELD = 6;

type Ranked = { name: string; slug: string; ms?: { p50: number } };

async function get(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Latency benches declaring "s" store milliseconds. The site has the same
 *  conversion in src/lib/format.ts; skipping it prints 260 s for a 0.26 s lag. */
function inDeclaredUnit(value: number, unit: string): number {
  return unit === "s" ? value / 1000 : value;
}

function format(value: number, unit: string): { value: string; unit: string } {
  const n = value;
  switch (unit) {
    case "s":
      return { value: n < 1 ? n.toFixed(2) : n.toFixed(1), unit: "s" };
    case "ms":
      return n >= 1000
        ? { value: (n / 1000).toFixed(1), unit: "s" }
        : { value: Math.round(n).toString(), unit: "ms" };
    case "pct":
      return {
        value: n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toPrecision(2),
        unit: "%",
      };
    case "bp":
      return { value: n.toFixed(n < 10 ? 1 : 0), unit: "bp" };
    case "usd":
      if (n >= 1e9) return { value: `$${(n / 1e9).toFixed(2)}`, unit: "B" };
      if (n >= 1e6) return { value: `$${(n / 1e6).toFixed(0)}`, unit: "M" };
      if (n >= 1e3) return { value: `$${(n / 1e3).toFixed(0)}`, unit: "k" };
      return { value: `$${n.toFixed(0)}`, unit: "" };
    case "count":
      if (n >= 1e6) return { value: (n / 1e6).toFixed(2), unit: "M" };
      if (n >= 1e3) return { value: (n / 1e3).toFixed(0), unit: "k" };
      return { value: Math.round(n).toString(), unit: "" };
    default:
      return { value: String(n), unit };
  }
}

/** The site's own category copy, cut to the one clause a film can hold. */
function categoryLine(label: string): string {
  const entry = CATEGORIES.find((c) => c.label === label);
  if (!entry) throw new Error(`unknown category: ${label}`);
  const sentences = entry.description.split(". ");
  // The second sentence is the one that says what is actually compared; the
  // first is the SEO lead-in and reads as boilerplate on screen.
  return (sentences[1] ?? sentences[0]).replace(/\.$/, "");
}

const citable = await get(`${API}/citable`);
const live = citable.benchmarks.filter((b: { status: string }) => b.status === "live");

const acts = [];
for (const act of ACTS) {
  const stat = await get(`${API}/stat/${act.slug}`);
  const ranked: Ranked[] = (stat.rankings ?? []).filter(
    (r: Ranked) => typeof r?.ms?.p50 === "number",
  );
  if (ranked.length < 2) throw new Error(`${act.slug}: only ${ranked.length} ranked`);

  const field = ranked.slice(0, MAX_FIELD).map((r, i) => {
    const raw = inDeclaredUnit(r.ms!.p50, stat.unit);
    const f = format(raw, stat.unit);
    return {
      name: r.name,
      slug: r.slug,
      logo: logoPath(r.slug),
      raw,
      value: f.value,
      unit: f.unit,
      rank: i + 1,
    };
  });

  acts.push({
    ...act,
    categoryLine: categoryLine(act.category),
    title: stat.title,
    unit: stat.unit,
    higherIsBetter: !!stat.higherIsBetter,
    ranked: stat.ranked ?? field.length,
    benchesInCategory: live.filter((b: { category: string }) => b.category === act.category).length,
    field,
  });
}

// RPCs get the breadth shot rather than a race: 165 chains is the claim.
const rpcLeaders: Record<string, { name: string; slug: string; chains: number }> = {};
for (const b of live) {
  if (b.category !== "RPCs" || !b.leader) continue;
  const k = b.leader.slug;
  rpcLeaders[k] = rpcLeaders[k] ?? { name: b.leader.name, slug: k, chains: 0 };
  rpcLeaders[k].chains += 1;
}
const rpcTop = Object.values(rpcLeaders)
  .sort((a, b) => b.chains - a.chains)
  .slice(0, 6)
  .map((r) => ({ ...r, logo: logoPath(r.slug) }));
const rpcChains = live.filter((b: { category: string }) => b.category === "RPCs").length;

const data = {
  generatedAt: new Date().toISOString(),
  asOf: citable.benchmarks[0]?.asOf ?? null,
  totals: {
    benchmarks: live.length,
    categories: new Set(live.map((b: { category: string }) => b.category)).size,
    rpcChains,
    samples: Math.round(
      live.reduce((a: number, b: { sampleSize?: number }) => a + (Number(b.sampleSize) || 0), 0),
    ),
    products: new Set(
      live.flatMap((b: { leaders?: Array<{ slug: string }> }) =>
        (b.leaders ?? []).map((l) => l.slug),
      ),
    ).size,
  },
  acts,
  rpc: { chains: rpcChains, top: rpcTop, categoryLine: categoryLine("RPCs") },
};

// Logos: copy only what the film references, so public/ stays reviewable.
const wanted = new Set<string>();
for (const a of acts) for (const f of a.field) if (f.logo) wanted.add(f.logo);
for (const r of rpcTop) if (r.logo) wanted.add(r.logo);
fs.mkdirSync(path.join(FILM, "public", "logos"), { recursive: true });
const missing: string[] = [];
for (const rel of wanted) {
  const src = path.join(REPO, "public", rel);
  if (!fs.existsSync(src)) {
    missing.push(rel);
    continue;
  }
  fs.copyFileSync(src, path.join(FILM, "public", rel.replace(/^\//, "")));
}

fs.writeFileSync(
  path.join(FILM, "src", "data.ts"),
  [
    "// GENERATED by scripts/fetch-data.ts. Do not hand-edit.",
    `// Fetched ${data.generatedAt} from openchainbench.com/api`,
    "",
    `export const FILM = ${JSON.stringify(data, null, 2)} as const;`,
    "",
  ].join("\n"),
);

console.log(`wrote src/data.ts, ${wanted.size - missing.length}/${wanted.size} logos`);
if (missing.length) console.log("MISSING LOGOS:", missing);
for (const a of acts) {
  console.log(`\n${a.category} (${a.shape}) · ${a.ranked} ranked · ${a.benchesInCategory} benches in category`);
  console.log(`  "${a.categoryLine}"`);
  for (const f of a.field) console.log(`  ${f.rank}. ${f.name.padEnd(18)} ${f.value}${f.unit}`);
}
try {
  execSync("git rev-parse --short HEAD", { cwd: REPO, stdio: "pipe" });
} catch {
  /* not a git checkout, nothing to stamp */
}
