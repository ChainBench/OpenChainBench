import { loadSpecsUncached, filterSig, type BenchmarkFilters } from "@/lib/materialize/load";
import { readMaterialized, readHeartbeat } from "@/lib/materialize/store";
import type { Spec } from "@/lib/spec-schema";

function variantCombos(spec: Spec): BenchmarkFilters[] {
  const dims = spec.dimensions ?? {};
  const chains = (dims.chain ?? []).map((d) => d.value).filter((v) => v !== "all");
  const regions = (dims.region ?? []).map((d) => d.value).filter((v) => v !== "all");
  const kinds = (dims.kind ?? []).map((d) => d.value).filter((v) => v !== "all");
  const opt = <T,>(xs: T[]): (T | undefined)[] => (xs.length ? [undefined, ...xs] : [undefined]);
  const out: BenchmarkFilters[] = [];
  for (const c of opt(chains)) for (const r of opt(regions)) for (const k of opt(kinds)) {
    if (!c && !r && !k) continue;
    out.push({ ...(c ? { chain: c } : {}), ...(r ? { region: r } : {}), ...(k ? { kind: k } : {}) });
  }
  return out;
}

async function main() {
  const specs = await loadSpecsUncached();
  const jobs: { slug: string; sig: string; agg: boolean }[] = [];
  for (const s of specs) {
    jobs.push({ slug: s.slug, sig: "", agg: true });
    for (const f of variantCombos(s)) jobs.push({ slug: s.slug, sig: filterSig(f), agg: false });
  }
  const hb = await readHeartbeat();
  console.log(`heartbeat: ${hb ? Math.round(Date.now() / 1000 - hb) + "s ago" : "NONE"}`);
  console.log(`expected views: ${jobs.length} (${specs.length} aggregates + ${jobs.length - specs.length} variants)`);

  let ok = 0; const misses: string[] = []; const stale: string[] = []; const thin: string[] = [];
  const ages: number[] = [];
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.all(jobs.slice(i, i + 10).map(async (j) => {
      const s = await readMaterialized(j.slug, j.sig);
      const name = `${j.slug}/${j.sig || "all"}`;
      if (!s) { misses.push(name); return; }
      const age = (Date.now() - s.builtAt) / 1000;
      ages.push(age);
      const limit = j.agg ? 240 : 900;
      if (age > limit) stale.push(`${name} (${Math.round(age)}s)`);
      const b = s.bench;
      if (j.agg && b.status === "live" && (!b.extras.series24h || Object.keys(b.extras.series24h).length === 0)) thin.push(`${name} no series`);
      ok++;
    }));
  }
  ages.sort((a, b) => a - b);
  console.log(`present: ${ok}/${jobs.length} | age p50 ${Math.round(ages[Math.floor(ages.length / 2)] ?? -1)}s, max ${Math.round(ages[ages.length - 1] ?? -1)}s`);
  console.log(`MISSING (${misses.length}):`, misses.slice(0, 15).join(", ") || "none");
  console.log(`STALE (${stale.length}):`, stale.slice(0, 10).join(", ") || "none");
  console.log(`THIN (${thin.length}):`, thin.slice(0, 10).join(", ") || "none");
}
main();
