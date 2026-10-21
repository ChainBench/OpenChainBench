// Motion pass: render every part of the video as a real clip (every
// frame, through renderMedia like the server), with the lab probe on, and
// keep the per-frame measurements. Stills only see three frames; what goes
// wrong between them (rows that jump, labels that cross, badges that
// flash) only shows here.
// usage: FORMAT=landscape|short node lab/motion.mjs <fixturesDir> <outDir> [raceSeconds]
//   writes <outDir>/<fixture>/<part>.mp4 (half size, preview quality) and
//   <part>.frames.json; lab/motion-checks.mjs reads the latter.
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";

const [fxDir, outDir, raceSecArg] = process.argv.slice(2);
const raceSeconds = Number(raceSecArg ?? 12);
const VIEWS = ["BarChartRace", "TimeSeriesRace", "DonutRace", "CountPodium"];
const FORMATS = { landscape: { width: 1920, height: 1080 }, short: { width: 1080, height: 1920 } };
const FORMAT = process.env.FORMAT ?? "landscape";
const { width, height } = FORMATS[FORMAT];
const PARALLEL = Number(process.env.PARALLEL ?? 8); // clips at once
const CONC = Number(process.env.CONC ?? 8); // tabs per clip
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // e.g. ONLY=BarChartRace
const additive = (b) => b.unit === "count" || (b.unit === "usd" && b.higherIsBetter);

const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), webpackOverride: (c) => c });
const browser = await openBrowser("chrome", { chromiumOptions: { gl: "swangle" } });
const jobs = [];
for (const f of fs.readdirSync(fxDir).filter((x) => x.endsWith(".json") && x !== "index.json" && !x.startsWith("."))) {
  const id = f.replace(/\.json$/, "");
  const bench = JSON.parse(fs.readFileSync(path.join(fxDir, f), "utf8"));
  for (const comp of [...VIEWS, "ResultsBoard", "Outro"]) {
    if (comp === "DonutRace" && !additive(bench)) continue;
    if (ONLY && !ONLY.includes(comp)) continue;
    jobs.push({ id, comp, inputProps: { theme: "dark", bench, beats: false, lab: true } });
  }
}

let done = 0, failed = 0;
const t0 = Date.now();
async function run(job) {
  const dir = path.join(outDir, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  try {
    const comp = await selectComposition({ serveUrl, id: job.comp, inputProps: job.inputProps, puppeteerInstance: browser });
    const dur = VIEWS.includes(job.comp) ? raceSeconds * comp.fps : comp.durationInFrames;
    await renderMedia({
      composition: { ...comp, durationInFrames: dur, width, height },
      serveUrl,
      codec: "h264",
      crf: 30,
      scale: 0.5,
      x264Preset: "veryfast",
      inputProps: job.inputProps,
      outputLocation: path.join(dir, `${job.comp}.mp4`),
      // Each clip gets its own browser: ten renders sharing one browser
      // (one software-GL process) took 24 s a clip instead of 13 s.
      chromiumOptions: { gl: "swangle" },
      concurrency: CONC,
      logLevel: "error",
      onBrowserLog: (l) => { if (l.text.startsWith("LABPROBE ")) frames.push(JSON.parse(l.text.slice(9))); },
    });
    frames.sort((a, b) => a.f - b.f);
    fs.writeFileSync(path.join(dir, `${job.comp}.frames.json`), JSON.stringify({ comp: job.comp, fps: comp.fps, dur, frames }));
  } catch (e) {
    failed++;
    fs.writeFileSync(path.join(dir, `${job.comp}.err.txt`), String(e?.stack ?? e));
  }
  done++;
  if (done % 10 === 0) console.log(`motion: ${done}/${jobs.length}`);
}
const queue = [...jobs];
await Promise.all(Array.from({ length: PARALLEL }, async () => { while (queue.length) await run(queue.shift()); }));
await browser.close({ silent: true });
console.log(`motion: ${done} clips, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
