// Independent scorer for bench server-wallet-cost. Written from the catalogue's
// prose model, NOT from the Go code: different language, different loops.
// Reads the same catalogue (scenarios included, never retyped) and checks
// the harness's curve file two ways:
//   1. every curve point's bill equals this scorer's bill at that MAU;
//   2. at N random MAU counts, linear interpolation of the curve (what the
//      browser does) equals this scorer's bill, which proves no corner is
//      missing from the curve.
// Usage, from the repository root:
//   node harnesses/server-wallet-cost/verify/scorer.mjs //     harnesses/server-wallet-cost/pricing/catalogue.yml src/data/server-wallet-cost-curves.json
// Exits non-zero on any disagreement. SERVER_WALLET_COST_TABLE=<path> also writes
// the bill at every gauge volume, which is what the spec's prose quotes.
import fs from "node:fs";
import yaml from "js-yaml";

const [, , catPath, curvePath, samplesArg] = process.argv;
const cat = yaml.load(fs.readFileSync(catPath, "utf8"));
const curves = JSON.parse(fs.readFileSync(curvePath, "utf8"));
const SAMPLES = Number(samplesArg || 30000);

function units(meter, sc, x) {
  const wallets = (sc.wallets_fixed || 0) + (sc.wallets_per_x || 0) * x;
  const tx = (sc.tx_fixed || 0) + (sc.tx_per_x || 0) * x;
  return (meter.per_wallet || 0) * wallets + (meter.per_tx || 0) * tx;
}

function fee(plan) {
  if (typeof plan.annual_usd === "number") return plan.annual_usd / 12;
  return plan.monthly_usd;
}

function tierCharge(q, tiers) {
  let charge = 0;
  let floor = 0;
  for (const t of tiers) {
    const ceil = t.up_to === undefined || t.up_to === null ? Infinity : t.up_to;
    const slice = Math.max(0, Math.min(q, ceil) - floor);
    charge += slice * t.rate;
    floor = ceil;
    if (q <= ceil) break;
  }
  return charge;
}

const TOL = 1e-9;
function planBill(p, plan, prof, mau) {
  const f = fee(plan);
  if (f === null || f === undefined) return null;
  for (const [m, cap] of Object.entries(plan.caps || {})) {
    if (units(p.meters[m], prof, mau) > cap * (1 + TOL)) return null;
  }
  for (const [m, lim] of Object.entries(plan.quote_above || {})) {
    if (units(p.meters[m], prof, mau) > lim * (1 + TOL)) return null;
  }
  let usage = 0;
  for (const [m, tiers] of Object.entries(plan.tiers || {})) usage += tierCharge(units(p.meters[m], prof, mau), tiers);
  return plan.minimum ? Math.max(f, usage) : f + usage;
}
function planUncertain(p, plan, prof, mau) {
  if (plan.confidence !== "verified") return true;
  for (const [m, lim] of Object.entries(plan.uncertain_above || {})) {
    if (units(p.meters[m], prof, mau) > lim * (1 + TOL)) return true;
  }
  return false;
}

function best(p, prof, mau) {
  if (p.scenario_exclusions && p.scenario_exclusions[prof.id]) return null;
  let out = null;
  for (const plan of p.plans) {
    const b = planBill(p, plan, prof, mau);
    if (b === null) continue;
    if (out === null || b < out.usd - 1e-9) {
      const unc = planUncertain(p, plan, prof, mau);
      out = { usd: b, plan: plan.id, unc, bound: unc ? plan.bound || "" : "" };
    }
  }
  return out;
}

function interp(points, x) {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (x >= a.x && x <= b.x) {
      if (a.usd === null || b.usd === null || a.usd === undefined || b.usd === undefined) {
        // A gap: the curve claims no price. Only an interval whose both
        // ends are null is a true gap; a single null end is a jump.
        if ((a.usd ?? null) === null && (b.usd ?? null) === null) return null;
        return x === a.x ? a.usd ?? null : x === b.x ? b.usd ?? null : "jump";
      }
      const t = (x - a.x) / (b.x - a.x);
      return { v: a.usd + t * (b.usd - a.usd), plan: x === a.x ? a.plan : x === b.x ? b.plan : a.next, unc: x === a.x ? Boolean(a.unc) : x === b.x ? Boolean(b.unc) : Boolean(a.nextUnc), bound: x === a.x ? a.bound || "" : x === b.x ? b.bound || "" : a.nextBound || "" };
    }
  }
  return undefined;
}

const ranked = cat.providers.filter((p) => p.cohort === "ranked");
let pointsChecked = 0, pointErrors = 0, sampleChecked = 0, sampleErrors = 0, jumps = 0;
const errs = [];
for (const cprof of curves.scenarios) {
  const prof = cat.scenarios.find((x) => x.id === cprof.id);
  if (!prof) throw new Error("curve scenario not in catalogue: " + cprof.id);
  if (cprof.txPerX !== prof.tx_per_x || cprof.walletsPerX !== prof.wallets_per_x || cprof.walletsFixed !== prof.wallets_fixed || cprof.floor !== prof.floor || cprof.ceiling !== prof.ceiling) throw new Error("scenario drift " + cprof.id);
  if (cprof.providers.length !== ranked.length) throw new Error(`provider count ${cprof.providers.length} != ${ranked.length}`);
  for (const cp of cprof.providers) {
    const p = ranked.find((x) => x.slug === cp.slug);
    if (!p) throw new Error("unknown provider in curve " + cp.slug);
    for (const pt of cp.points) {
      pointsChecked++;
      const want = best(p, prof, pt.x);
      const got = pt.usd ?? null;
      const bad = (want === null) !== (got === null) || (want && Math.abs(want.usd - got) > 0.005 + 1e-9) || (want && want.plan !== pt.plan) || (want && want.unc !== Boolean(pt.unc)) || (want && want.bound !== (pt.bound || ""));
      if (bad) { pointErrors++; errs.push(`${cprof.id} ${cp.slug} @${pt.x}: curve ${got}/${pt.plan} scorer ${want && want.usd}/${want && want.plan}`); }
    }
    // random log-uniform samples
    const lo = Math.log(cprof.floor), hi = Math.log(cprof.ceiling);
    let seed = 12345 + cp.slug.length * 7 + cprof.id.length;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < SAMPLES; i++) {
      const x = Math.exp(lo + rnd() * (hi - lo));
      const want = best(p, prof, x);
      const got = interp(cp.points, x);
      if (got === "jump") { jumps++; continue; }
      sampleChecked++;
      const wantUsd = want ? want.usd : null;
      const gotUsd = got === null ? null : got.v;
      // curve endpoints are rounded to cents, so allow a cent; the plan named
      // for the segment must be the scorer's plan at that MAU
      const bad = (wantUsd === null) !== (gotUsd === null) || (wantUsd !== null && (Math.abs(wantUsd - gotUsd) > 0.01 + 1e-9 || want.plan !== got.plan || want.unc !== got.unc || want.bound !== got.bound));
      if (bad) { sampleErrors++; if (errs.length < 40) errs.push(`SAMPLE ${cprof.id} ${cp.slug} @${x.toFixed(3)}: interp ${gotUsd}/${got && got.plan} scorer ${wantUsd}/${want && want.plan}`); }
    }
  }
}
// gauge sizes
const table = {};
for (const sc of cat.scenarios) for (const z of sc.sizes) for (const p of ranked) {
  const b = best(p, sc, z.x);
  table[`${sc.id}|${z.id}|${p.slug}`] = b ? Math.round(b.usd * 100) / 100 : null;
}
if (process.env.SERVER_WALLET_COST_TABLE) fs.writeFileSync(process.env.SERVER_WALLET_COST_TABLE, JSON.stringify(table, null, 1));
console.log(JSON.stringify({ pointsChecked, pointErrors, sampleChecked, sampleErrors, jumpsSkipped: jumps }));
for (const e of errs.slice(0, 40)) console.log(e);
process.exit(pointErrors + sampleErrors > 0 ? 1 : 0);
