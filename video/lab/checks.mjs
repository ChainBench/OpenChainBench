// Automatic gate on the lab stills: reads every <comp>-<key>.probe.json
// that lab/stills.mjs wrote, plus the PNG and the fixture, and reports
// what a viewer would see as broken. A part with a FAIL is not shown for
// review.
// usage: node lab/checks.mjs <framesDir> <fixturesDir> [out.json]
//
// Checks, per still:
//   RENDER_ERROR  the still failed to render                       FAIL
//   OUT_OF_FRAME  readable text runs past the frame edge             FAIL
//   OVERLAP       two readable texts cover each other                FAIL
//   BAD_TEXT      NaN, undefined, Infinity, e-notation on screen     FAIL
//   VALUE_RANGE   a value label is not a value the data can produce  FAIL
//   EMOJI         an emoji, which the render boxes print as a box     FAIL
//   MID_ROLL      an odometer digit caught between two digits on the    FAIL
//                 last readable frame, when the race has stopped
//   LOGO_EMPTY    a logo chip whose image did not load               FAIL
//   LOGO_FALLBACK a provider with a logo shows initials instead      WARN
//   LOGO_CONTRAST the logo barely shows on its chip                  WARN
//   CLIPPED       readable text cut by its container                 WARN
//   TINY_TEXT     text under 22 px, unreadable on a phone            WARN
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const [framesDir, fxDir, outArg] = process.argv.slice(2);
const out = outArg ?? path.join(framesDir, "checks.json");

const READABLE = 0.6; // effective opacity above which text counts as on screen
const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);
function inter(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

// Displayed text -> number in the bench's unit, or null when the text is
// not a value of that unit. Independent of formatters.ts on purpose: the
// point is to catch the formatter being wrong.
function parseValue(text, unit, isValue) {
  const t = text.replace(/\u2212/g, "-").replace(/,/g, "").trim();
  const delta = /^[+-]/.test(t);
  const KM = { k: 1e3, M: 1e6 };
  let m, v = null, scale = 1;
  if (unit === "s" || unit === "ms") {
    const toUnit = unit === "s" ? { ms: 1e-3, s: 1, min: 60 } : { ms: 1, s: 1e3, min: 6e4 };
    if ((m = t.match(/^[+-]?(\d+)m (\d+)s$/))) { scale = toUnit.s; v = (Number(m[1]) * 60 + Number(m[2])) * scale; }
    else if ((m = t.match(/^[+-]?(\d+(?:\.\d+)?)\s?(ms|s|min)$/))) { scale = toUnit[m[2]]; v = Number(m[1]) * scale; }
  } else if (unit === "usd") {
    if ((m = t.match(/^[+-]?<?\$(\d+(?:\.\d+)?)([kM])?$/))) { scale = KM[m[2]] ?? 1; v = Number(m[1]) * scale; }
  } else if (unit === "count") {
    if ((m = t.match(/^[+-]?(\d+(?:\.\d+)?)([kM])$/))) { scale = KM[m[2]]; v = Number(m[1]) * scale; }
    else if (isValue && (m = t.match(/^[+-]?(\d+)$/))) v = Number(m[1]);
  } else if (unit === "pct" || unit === "%") {
    if ((m = t.match(/^[+-]?(\d+(?:\.\d+)?)%$/))) v = Number(m[1]);
  } else if (unit === "bps") {
    if ((m = t.match(/^[+-]?(\d+(?:\.\d+)?) bps$/))) v = Number(m[1]);
  }
  if (v === null) return null;
  const dec = (t.match(/\.(\d+)/)?.[1].length) ?? 0;
  // Half of the last printed digit: the most rounding can have moved it.
  return { v, delta, half: 0.5 * 10 ** -dec * scale };
}

function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Share of pixels inside the logo area that stand out from the chip
// background (contrast >= 1.6). A dark mark on a dark chip scores ~0.
async function logoInk(png, box) {
  const meta = await sharp(png).metadata();
  const inset = box.w * 0.11;
  const L = Math.round(box.x + inset), T = Math.round(box.y + inset);
  const W = Math.round(box.w - 2 * inset), H = Math.round(box.h - 2 * inset);
  if (L < 0 || T < 0 || W < 4 || H < 4 || L + W > meta.width || T + H > meta.height) return null;
  const { data, info } = await sharp(png).extract({ left: L, top: T, width: W, height: H }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = [data[0], data[1], data[2]]; // corner of the logo area = chip surface
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) if (contrast(bg, [data[i], data[i + 1], data[i + 2]]) >= 1.6) ink++;
  return ink / (data.length / info.channels);
}

const fixtures = {};
for (const f of fs.readdirSync(fxDir)) {
  if (f.endsWith(".json") && f !== "index.json" && !f.startsWith(".")) fixtures[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(fxDir, f), "utf8"));
}

const results = [];
const logoSeen = new Set();
for (const fx of fs.readdirSync(framesDir).sort()) {
  const dir = path.join(framesDir, fx);
  if (!fs.statSync(dir).isDirectory()) continue;
  const bench = fixtures[fx];
  let lo = Infinity, hi = -Infinity, sumLast = 0;
  if (bench) {
    for (const p of bench.providers) {
      const vs = p.values.filter((x) => Number.isFinite(x));
      for (const x of vs) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      sumLast += vs.reduce((a, b) => a + b, 0);
    }
  }
  const additive = bench && (bench.unit === "count" || (bench.unit === "usd" && bench.higherIsBetter));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".png")).sort()) {
    const png = path.join(dir, f);
    const [comp, key] = f.slice(0, -4).split("-");
    const issues = [];
    const add = (level, code, msg, box) => issues.push(box ? { level, code, msg, box } : { level, code, msg });
    if (fs.existsSync(png + ".err.txt")) add("FAIL", "RENDER_ERROR", fs.readFileSync(png + ".err.txt", "utf8").split("\n")[0].slice(0, 160));
    const probeFile = png.replace(/\.png$/, ".probe.json");
    const probe = fs.existsSync(probeFile) ? JSON.parse(fs.readFileSync(probeFile, "utf8")).probe : null;
    if (!probe) {
      if (!issues.length) add("WARN", "NO_PROBE", "the probe did not report for this still");
      results.push({ fx, comp, key, issues });
      continue;
    }
    const frame = { x: 0, y: 0, w: probe.w, h: probe.h };
    const readable = probe.texts.filter((x) => x.op >= READABLE && x.vis && area(x.vis) >= 0.5 * area(x.box));

    for (const x of readable) {
      const b = x.box;
      const past = Math.max(-b.x, -b.y, b.x + b.w - frame.w, b.y + b.h - frame.h);
      if (past > 4) add("FAIL", "OUT_OF_FRAME", `"${x.t}" runs ${Math.round(past)} px past the frame edge`, b);
      if (/NaN|undefined|Infinity|\bnull\b|\de[-+]?\d/.test(x.t)) add("FAIL", "BAD_TEXT", `"${x.t}"`);
      // Neither renderer box has an emoji font: an emoji prints as an empty box.
      if (/\p{Extended_Pictographic}/u.test(x.t)) add("FAIL", "EMOJI", `"${x.t}" prints as an empty box on the render servers (no emoji font)`, b);
    }
    const tiny = [...new Set(readable.filter((x) => x.fs < 22).map((x) => `${x.t} (${x.fs}px)`))];
    if (tiny.length) add("WARN", "TINY_TEXT", `${tiny.length} labels under 22 px, e.g. ${tiny.slice(0, 3).join(", ")}`);
    if (key === "c") {
      for (const x of readable) if (x.midRoll) add("FAIL", "MID_ROLL", `"${x.t}" has ${x.midRoll} digit(s) between two numbers at rest`, x.box);
    }
    for (const x of probe.texts) {
      if (x.op < READABLE || !x.vis || x.val) continue;
      const share = area(x.vis) / area(x.box);
      if (share > 0.05 && share < 0.92) add("WARN", "CLIPPED", `"${x.t}" shows ${Math.round(share * 100)}%`);
    }
    // Ink box: a line box carries ascent and descent padding, so two
    // stacked labels with a tight line height "touch" without any glyph
    // touching. Keep the middle 0.72 em, where caps and digits sit.
    const ink = (x) => {
      const h = Math.min(x.vis.h, 0.72 * x.fs);
      return { x: x.vis.x, y: x.vis.y + (x.vis.h - h) / 2, w: x.vis.w, h };
    };
    for (let i = 0; i < readable.length; i++) {
      for (let j = i + 1; j < readable.length; j++) {
        const a = { ...readable[i], vis: ink(readable[i]) }, b = { ...readable[j], vis: ink(readable[j]) };
        const o = inter(a.vis, b.vis);
        if (!o) continue;
        const small = Math.min(area(a.vis), area(b.vis));
        // Same string on the same spot is a deliberate glow or shadow layer.
        if (a.t === b.t && area(o) > 0.8 * small) continue;
        if (area(o) > 0.2 * small) add("FAIL", "OVERLAP", `"${a.t}" and "${b.t}" overlap (${Math.round((100 * area(o)) / small)}%)`, o);
      }
    }

    if (bench) {
      // A value can never leave the data's own range (a sum, for additive
      // metrics). Axis ticks stop at round numbers, so they get room above
      // the max and are not checked against the min; a value label is.
      const top = (additive ? Math.max(hi, sumLast) : hi) * 2.5;
      for (const x of readable) {
        const p = parseValue(x.t, bench.unit, x.val);
        if (!p) continue;
        const slack = p.half;
        if (p.delta) {
          if (p.v - slack > (hi - lo) * 1.05) add("FAIL", "VALUE_RANGE", `delta "${x.t}" is larger than the data's whole spread`);
          continue;
        }
        if (p.v - slack > top) add("FAIL", "VALUE_RANGE", `"${x.t}" is above anything in the data (max ${hi})`);
        if (x.val && p.v + slack < lo / 1.6) add("FAIL", "VALUE_RANGE", `"${x.t}" is below anything in the data (min ${lo})`);
      }
    }

    for (const c of probe.logos ?? []) {
      if (c.op < READABLE) continue;
      if (c.kind === "logo" && c.loaded === false) add("FAIL", "LOGO_EMPTY", `${c.name}: ${c.src}`);
      if (c.kind === "fallback") add("WARN", "LOGO_FALLBACK", `${c.name}: logo did not load, initials shown`);
      if (c.kind === "logo" && c.loaded && c.box.w >= 28 && !logoSeen.has(`${fx}|${c.name}`)) {
        const ink = await logoInk(png, c.box);
        if (ink !== null) {
          logoSeen.add(`${fx}|${c.name}`);
          if (ink < 0.04) add("WARN", "LOGO_CONTRAST", `${c.name}: ${Math.round(ink * 100)}% of the logo stands out from its chip`, c.box);
        }
      }
    }
    // One line per distinct problem: a bar race repeats the same issue on
    // every row.
    const seen = new Set();
    results.push({ fx, comp, key, issues: issues.filter((i) => !seen.has(i.code + i.msg) && seen.add(i.code + i.msg)) });
  }
}

fs.writeFileSync(out, JSON.stringify(results, null, 1));
const count = (lvl) => results.reduce((n, r) => n + r.issues.filter((i) => i.level === lvl).length, 0);
const byPart = {};
for (const r of results) {
  const k = r.comp;
  byPart[k] ??= { FAIL: 0, WARN: 0, stills: 0 };
  byPart[k].stills++;
  for (const i of r.issues) byPart[k][i.level] = (byPart[k][i.level] ?? 0) + 1;
}
for (const [k, v] of Object.entries(byPart)) console.log(`${k.padEnd(18)} ${String(v.stills).padStart(3)} stills  FAIL ${v.FAIL}  WARN ${v.WARN}`);
console.log(`checks: ${results.length} stills, ${count("FAIL")} FAIL, ${count("WARN")} WARN -> ${out}`);
process.exitCode = count("FAIL") ? 1 : 0;
