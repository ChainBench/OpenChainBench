// Build the review bundle: one strip per (format, part, fixture, round),
// key frames side by side, with the automatic checks' FAIL boxes drawn
// in red, plus data.json for the review page.
// usage: node lab/review.mjs <outDir> <fixturesDir> <round>=<roundDir> [...] [motion:<round>=<motionDir>]
//   each <roundDir> holds landscape/ and short/ from lab/stills.mjs and
//   their checks.json from lab/checks.mjs. A motionDir holds landscape/
//   and short/ from lab/motion.mjs with motion-checks.json: its clips are
//   re-encoded small into <outDir>/clips (one set, the latest round's).
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [outDir, fxDir, ...roundArgs] = process.argv.slice(2);
const rounds = roundArgs.filter((a) => !a.startsWith("motion:")).map((a) => { const [id, dir] = a.split("="); return { id, dir }; });
const motions = roundArgs.filter((a) => a.startsWith("motion:")).map((a) => { const [id, dir] = a.slice(7).split("="); return { id, dir }; });
const PARTS = ["Intro", "BarChartRace", "TimeSeriesRace", "DonutRace", "CountPodium", "ResultsBoard", "Outro"];
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
// Motion: clips at 640 px wide for the page, plus what motion-checks found.
for (const m of motions) {
  for (const fmt of ["landscape", "short"]) {
    const base = path.join(m.dir, fmt);
    const mc = path.join(base, "motion-checks.json");
    if (!fs.existsSync(mc)) continue;
    for (const r of JSON.parse(fs.readFileSync(mc, "utf8"))) {
      const src = path.join(base, r.fx, `${r.comp}.mp4`);
      const rel = path.join("clips", fmt, r.comp, `${r.fx}.mp4`);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
        // Remotion ships its own ffmpeg; the box has none.
        execFileSync("npx", ["remotion", "ffmpeg", "-loglevel", "error", "-y", "-i", src,
          "-vf", fmt === "short" ? "scale=360:-2" : "scale=640:-2",
          "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
          path.join(outDir, rel)], { stdio: "pipe" });
      }
      const key = `${m.id}|${fmt}|${r.comp}|${r.fx}`;
      data.cells[key] ??= { img: null, frames: [], issues: [] };
      data.cells[key].motion = { clip: fs.existsSync(path.join(outDir, rel)) ? rel : null, issues: r.issues, maxJumpPx: r.maxJumpPx, flickerPerSec: r.flickerPerSec };
    }
  }
}

// Reference frames from the brand film (#2970), copied into <outDir>/film.
const filmDir = path.join(outDir, "film");
data.film = fs.existsSync(filmDir) ? fs.readdirSync(filmDir).filter((f) => f.endsWith(".jpg")).sort().map((f) => `film/${f}`) : [];
fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data));
console.log(`review: ${Object.keys(data.cells).length} strips -> ${outDir}`);
