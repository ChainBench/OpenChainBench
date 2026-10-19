// Render key frames for every fixture x composition, for contact sheets.
// usage: node lab/stills.mjs <fixturesDir> <outDir> [raceSeconds]
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition, openBrowser } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";

const [fxDir, outDir, raceSecArg] = process.argv.slice(2);
const raceSeconds = Number(raceSecArg ?? 12);
const VIEWS = ["BarChartRace", "TimeSeriesRace", "DistributionRace", "DonutRace", "CountPodium"];
const TAIL = ["ResultsBoard", "Outro"];
const FRACS = [0.04, 0.2, 0.4, 0.6, 0.8, 0.99];
const CONC = Number(process.env.CONC ?? 12);
// Same shapes production renders (server.mjs FORMATS).
const FORMATS = { landscape: { width: 1920, height: 1080 }, short: { width: 1080, height: 1920 } };
const FORMAT = process.env.FORMAT ?? "landscape";
const { width, height } = FORMATS[FORMAT];

const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), webpackOverride: (c) => c });
const browser = await openBrowser("chrome", { chromiumOptions: { gl: "swangle" } });
const fixtures = fs.readdirSync(fxDir).filter((f) => f.endsWith(".json") && f !== "index.json");
const jobs = [];
for (const f of fixtures) {
  const id = f.replace(/\.json$/, "");
  const bench = JSON.parse(fs.readFileSync(path.join(fxDir, f), "utf8"));
  const inputProps = { theme: "dark", bench, beats: false };
  for (const comp of [...VIEWS, ...TAIL]) {
    jobs.push({ id, comp, inputProps });
  }
}
let done = 0, failed = 0;
const t0 = Date.now();
async function run(job) {
  const comp = await selectComposition({ serveUrl, id: job.comp, inputProps: job.inputProps, puppeteerInstance: browser });
  const dur = VIEWS.includes(job.comp) ? raceSeconds * comp.fps : comp.durationInFrames;
  const fracs = job.comp === "Outro" ? [0.5] : job.comp === "ResultsBoard" ? [0.3, 0.95] : FRACS;
  for (const fr of fracs) {
    const frame = Math.min(dur - 1, Math.round(fr * dur));
    const dir = path.join(outDir, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const output = path.join(dir, `${job.comp}-${String(Math.round(fr * 100)).padStart(2, "0")}.png`);
    try {
      await renderStill({ composition: { ...comp, durationInFrames: dur, width, height }, serveUrl, frame, output, inputProps: job.inputProps, puppeteerInstance: browser, chromiumOptions: { gl: "swangle" } });
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
