// Render the key frames of every part of the video, for every fixture,
// with the lab probe on: each PNG gets a <name>.probe.json beside it that
// lab/checks.mjs reads.
// usage: FORMAT=landscape|short node lab/stills.mjs <fixturesDir> <outDir> [raceSeconds]
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition, openBrowser } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";

const [fxDir, outDir, raceSecArg] = process.argv.slice(2);
const raceSeconds = Number(raceSecArg ?? 12);
export const VIEWS = ["BarChartRace", "TimeSeriesRace", "DonutRace", "CountPodium"];
const CONC = Number(process.env.CONC ?? 12);
// Same shapes production renders (server.mjs FORMATS).
const FORMATS = { landscape: { width: 1920, height: 1080 }, short: { width: 1080, height: 1920 } };
const FORMAT = process.env.FORMAT ?? "landscape";
const { width, height } = FORMATS[FORMAT];
// Which views the site offers for a metric (src/lib/export-video/types.ts
// viewsForMetric): Donut only for additive metrics.
const additive = (b) => b.unit === "count" || (b.unit === "usd" && b.higherIsBetter);

// Key frames per part. a = the race has started, b = middle, c = the last
// readable frame before the 12-frame fade out (the frame a viewer pauses on).
function framesFor(comp, dur) {
  if (VIEWS.includes(comp)) return { a: Math.round(dur * 0.12), b: Math.round(dur * 0.5), c: dur - 16 };
  if (comp === "ResultsBoard") return { a: Math.round(dur * 0.35), c: dur - 16 };
  if (comp === "Outro") return { a: Math.round(dur * 0.4), c: dur - 12 };
  return { a: Math.round(dur * 0.25), b: Math.round(dur * 0.55), c: dur - 2 }; // Intro
}

const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), webpackOverride: (c) => c });
const browser = await openBrowser("chrome", { chromiumOptions: { gl: "swangle" } });
const fixtures = fs.readdirSync(fxDir).filter((f) => f.endsWith(".json") && f !== "index.json" && !f.startsWith("."));
const jobs = [{ id: "_intro", comp: "Intro", inputProps: { theme: "dark", lab: true } }];
for (const f of fixtures) {
  const id = f.replace(/\.json$/, "");
  const bench = JSON.parse(fs.readFileSync(path.join(fxDir, f), "utf8"));
  const inputProps = { theme: "dark", bench, beats: false, lab: true };
  for (const comp of [...VIEWS, "ResultsBoard", "Outro"]) {
    if (comp === "DonutRace" && !additive(bench)) continue;
    jobs.push({ id, comp, inputProps });
  }
}
let done = 0, failed = 0;
const t0 = Date.now();
async function run(job) {
  // A browser tab can die under 24-way concurrency; one retry, then the
  // still is recorded as an error instead of killing the whole pass.
  let comp;
  for (let i = 0; !comp; i++) {
    try { comp = await selectComposition({ serveUrl, id: job.comp, inputProps: job.inputProps, puppeteerInstance: browser }); }
    catch (e) { if (i) { failed++; console.error(job.id, job.comp, String(e).slice(0, 200)); return; } }
  }
  const dur = VIEWS.includes(job.comp) ? raceSeconds * comp.fps : comp.durationInFrames;
  const dir = path.join(outDir, job.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, frame] of Object.entries(framesFor(job.comp, dur))) {
    const output = path.join(dir, `${job.comp}-${key}.png`);
    let probe = null;
    const render = () => renderStill({
      composition: { ...comp, durationInFrames: dur, width, height },
      serveUrl, frame, output, inputProps: job.inputProps, puppeteerInstance: browser,
      chromiumOptions: { gl: "swangle" },
      logLevel: "error",
      onBrowserLog: (l) => { if (l.text.startsWith("LABPROBE ")) probe = JSON.parse(l.text.slice(9)); },
    });
    try {
      // "Visited index.html but got no response" happens under load; retry once.
      await render().catch(() => render());
      fs.writeFileSync(output.replace(/\.png$/, ".probe.json"), JSON.stringify({ comp: job.comp, key, frame, dur, probe }));
    } catch (e) {
      failed++; fs.writeFileSync(output + ".err.txt", String(e?.stack ?? e));
    }
    done++;
  }
}
const queue = [...jobs];
await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) await run(queue.shift()); }));
await browser.close({ silent: true });
console.log(`stills: ${done} frames, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
