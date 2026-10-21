// What a delivered file weighs: renders race + ResultsBoard + Outro with
// the server's exact encoder settings (server.mjs renderOpts) for a few
// fixtures and grain/crf variants, and reports MB and Mbit/s. The intro
// is a fixed pre-rendered file, added from its measured size. The race
// clips are kept so banding can be judged on the encoded frames.
// usage: node lab/weight.mjs <fixturesDir> <outDir> [fixture,fixture]
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";

const [fxDir, outDir, list] = process.argv.slice(2);
const fixtures = (list ?? "headlag-seconds,netfees-tiny").split(",");
const INTRO_BYTES = 810478; // /mnt/video-renderer/poc/public/intro.mp4 on the Paris renderer, 2026-10-19
const VARIANTS = [
  { id: "boil-crf19", grain: "boil", crf: 19 }, // production today
  { id: "static-crf19", grain: "static", crf: 19 },
  { id: "off-crf19", grain: "off", crf: 19 },
  { id: "boil-crf23", grain: "boil", crf: 23 },
];
const VIEW = process.env.VIEW ?? "BarChartRace";
const raceSeconds = 12;

const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), webpackOverride: (c) => c });
const browser = await openBrowser("chrome", { chromiumOptions: { gl: "swangle" } });
fs.mkdirSync(outDir, { recursive: true });
const rows = [];
await Promise.all(fixtures.flatMap((fx) => VARIANTS.map(async (v) => {
  const bench = JSON.parse(fs.readFileSync(path.join(fxDir, `${fx}.json`), "utf8"));
  const inputProps = { theme: "dark", bench, beats: false, labGrain: v.grain };
  let bytes = INTRO_BYTES, seconds = 3;
  for (const id of [VIEW, "ResultsBoard", "Outro"]) {
    const comp = await selectComposition({ serveUrl, id, inputProps, puppeteerInstance: browser });
    const dur = id === VIEW ? raceSeconds * comp.fps : comp.durationInFrames;
    const out = path.join(outDir, `${fx}.${v.id}.${id}.mp4`);
    await renderMedia({
      composition: { ...comp, durationInFrames: dur, width: 1920, height: 1080 },
      serveUrl, codec: "h264", inputProps, imageFormat: "jpeg", jpegQuality: 90,
      x264Preset: "veryfast", crf: v.crf, colorSpace: "bt709",
      outputLocation: out, puppeteerInstance: browser, chromiumOptions: { gl: "swangle" },
      concurrency: 6, logLevel: "error",
    });
    bytes += fs.statSync(out).size;
    seconds += dur / comp.fps;
  }
  rows.push({ fx, variant: v.id, MB: Number((bytes / 1e6).toFixed(1)), seconds: Number(seconds.toFixed(1)), mbps: Number(((bytes * 8) / seconds / 1e6).toFixed(1)) });
})));
await browser.close({ silent: true });
rows.sort((a, b) => a.fx.localeCompare(b.fx) || a.variant.localeCompare(b.variant));
fs.writeFileSync(path.join(outDir, "weight.json"), JSON.stringify(rows, null, 1));
for (const r of rows) console.log(`${r.fx.padEnd(18)} ${r.variant.padEnd(14)} ${String(r.MB).padStart(6)} MB  ${r.seconds} s  ${r.mbps} Mbit/s`);
