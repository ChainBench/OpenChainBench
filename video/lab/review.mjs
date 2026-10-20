// Build the review bundle: one strip per (format, part, fixture, round),
// key frames side by side, with the automatic checks' FAIL boxes drawn
// in red, plus data.json for the review page.
// usage: node lab/review.mjs <outDir> <fixturesDir> <round>=<roundDir> [<round>=<roundDir> ...]
//   each <roundDir> holds landscape/ and short/ from lab/stills.mjs and
//   their checks.json from lab/checks.mjs.
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const [outDir, fxDir, ...roundArgs] = process.argv.slice(2);
const rounds = roundArgs.map((a) => { const [id, dir] = a.split("="); return { id, dir }; });
const PARTS = ["Intro", "BarChartRace", "TimeSeriesRace", "DistributionRace", "DonutRace", "CountPodium", "ResultsBoard", "Outro"];
const CELL = { landscape: [640, 360], short: [270, 480] };
const GAP = 4;

const index = JSON.parse(fs.readFileSync(path.join(fxDir, "index.json"), "utf8"));
const fixtures = [{ id: "_intro", why: "same for every bench" }, ...index.map((f) => ({ id: f.id, slug: f.slug, why: f.why, unit: f.unit, providers: f.providers }))];
const data = { built: new Date().toISOString(), rounds: rounds.map((r) => r.id), parts: PARTS, fixtures, cells: {} };

for (const r of rounds) {
  for (const fmt of ["landscape", "short"]) {
    const base = path.join(r.dir, fmt);
    if (!fs.existsSync(base)) continue;
    const checks = JSON.parse(fs.readFileSync(path.join(base, "checks.json"), "utf8"));
    const [cw, ch] = CELL[fmt];
    for (const fx of fixtures) {
      for (const part of PARTS) {
        const keys = ["a", "b", "c"].filter((k) => fs.existsSync(path.join(base, fx.id, `${part}-${k}.png`)));
        if (!keys.length) continue;
        const composites = [];
        const issues = [];
        for (const [i, k] of keys.entries()) {
          const png = path.join(base, fx.id, `${part}-${k}.png`);
          const meta = await sharp(png).metadata();
          const sx = cw / meta.width, sy = ch / meta.height;
          const found = checks.find((c) => c.fx === fx.id && c.comp === part && c.key === k);
          const mine = found?.issues ?? [];
          issues.push(...mine.map((x) => ({ ...x, key: k, box: undefined })));
          const boxes = mine.filter((x) => x.box && x.level === "FAIL").map((x) => x.box);
          const warnBoxes = mine.filter((x) => x.box && x.level === "WARN").map((x) => x.box);
          const rect = (b, c) => `<rect x="${(b.x * sx).toFixed(1)}" y="${(b.y * sy).toFixed(1)}" width="${Math.max(3, b.w * sx).toFixed(1)}" height="${Math.max(3, b.h * sy).toFixed(1)}" fill="none" stroke="${c}" stroke-width="2"/>`;
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">${boxes.map((b) => rect(b, "#ff3b3b")).join("")}${warnBoxes.map((b) => rect(b, "#ffb020")).join("")}</svg>`;
          const img = await sharp(png).resize(cw, ch).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).png().toBuffer();
          composites.push({ input: img, left: i * (cw + GAP), top: 0 });
        }
        const rel = path.join(fmt, part, `${fx.id}.${r.id}.jpg`);
        fs.mkdirSync(path.join(outDir, fmt, part), { recursive: true });
        await sharp({ create: { width: keys.length * cw + (keys.length - 1) * GAP, height: ch, channels: 3, background: "#08080a" } })
          .composite(composites).jpeg({ quality: 72, mozjpeg: true }).toFile(path.join(outDir, rel));
        // Keep one line per distinct problem across the key frames.
        const seen = new Map();
        for (const x of issues) {
          const id = x.code + "|" + x.msg;
          if (seen.has(id)) seen.get(id).keys.push(x.key);
          else seen.set(id, { level: x.level, code: x.code, msg: x.msg, keys: [x.key] });
        }
        data.cells[`${r.id}|${fmt}|${part}|${fx.id}`] = { img: rel, frames: keys, issues: [...seen.values()] };
      }
    }
  }
}
// Reference frames from the brand film (#2970), copied into <outDir>/film.
const filmDir = path.join(outDir, "film");
data.film = fs.existsSync(filmDir) ? fs.readdirSync(filmDir).filter((f) => f.endsWith(".jpg")).sort().map((f) => `film/${f}`) : [];
fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data));
console.log(`review: ${Object.keys(data.cells).length} strips -> ${outDir}`);
