// Render-pipeline benchmark: one export (race + ResultsBoard + Outro) per
// variant, timed, with the summed RSS of node + every Chrome child sampled
// every 250 ms. Run under `taskset -c a,b` to mimic the 2-vCPU renderer.
// usage: node lab/perf.mjs <fixture.json> <view> <raceSeconds> <outDir> <variant...>
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [fx, view, secs, outDir, ...variants] = process.argv.slice(2);
const bench = JSON.parse(fs.readFileSync(fx, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const GL = process.env.GL ?? "swangle";
const inputProps = { theme: "dark", bench };

function treeRss() {
  const rows = execSync("ps -eo pid=,ppid=,rss=").toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
  const rss = new Map(rows.map(([p, , r]) => [p, r]));
  let sum = 0; const st = [process.pid];
  while (st.length) { const p = st.pop(); sum += rss.get(p) ?? 0; st.push(...(kids.get(p) ?? [])); }
  return sum / 1024;
}

const V = {
  // what server.mjs does today
  current: { parallel: true, shared: false, conc: 2, img: "jpeg", q: 90, preset: "veryfast", crf: 19 },
  shared2: { parallel: false, shared: true, conc: 2, img: "jpeg", q: 90, preset: "veryfast", crf: 19 },
  shared3: { parallel: false, shared: true, conc: 3, img: "jpeg", q: 90, preset: "veryfast", crf: 19 },
  sharedHQ: { parallel: false, shared: true, conc: 2, img: "jpeg", q: 95, preset: "medium", crf: 18, tune: true },
  sharedPNG: { parallel: false, shared: true, conc: 2, img: "png", preset: "medium", crf: 18, tune: true },
  sharedQ: { parallel: false, shared: true, conc: 2, img: "jpeg", q: 95, preset: "veryfast", crf: 18, tune: true },
  parQ: { parallel: true, shared: false, conc: 2, img: "jpeg", q: 95, preset: "veryfast", crf: 18, tune: true },
  ref: { parallel: false, shared: true, conc: 2, img: "png", prores: true, raceOnly: true },
};

for (const name of variants) {
  const v = V[name];
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, treeRss()); }, 250);
  const t0 = Date.now();
  const browser = v.shared ? await openBrowser("chrome", { chromiumOptions: { gl: GL } }) : undefined;
  const segs = [[view, Number(secs) * 30], ...(v.raceOnly ? [] : [["ResultsBoard"], ["Outro"]])];
  const jobs = segs.map(([id, dur]) => async () => {
    const comp = await selectComposition({ serveUrl, id, inputProps, puppeteerInstance: browser, chromiumOptions: { gl: GL } });
    const out = path.join(outDir, `${name}-${id}.${v.prores ? "mov" : "mp4"}`);
    await renderMedia({
      serveUrl, inputProps, puppeteerInstance: browser, chromiumOptions: { gl: GL },
      ...(v.prores ? { codec: "prores", proresProfile: "4444" } : { codec: "h264", x264Preset: v.preset, crf: v.crf, colorSpace: "bt709" }),
      composition: { ...comp, ...(dur ? { durationInFrames: dur } : {}) },
      imageFormat: v.img, ...(v.img === "jpeg" ? { jpegQuality: v.q } : {}),
      concurrency: v.conc, logLevel: "error",
      ...(v.tune ? { ffmpegOverride: ({ args }) => { const i = args.indexOf("-crf"); return i < 0 ? args : [...args.slice(0, i), "-tune", "animation", ...args.slice(i)]; } } : {}),
      outputLocation: out,
    });
    return out;
  });
  const outs = v.parallel ? await Promise.all(jobs.map((j) => j())) : await (async () => { const o = []; for (const j of jobs) o.push(await j()); return o; })();
  if (browser) await browser.close({ silent: true });
  clearInterval(timer);
  const ms = Date.now() - t0;
  const size = outs.reduce((s, f) => s + fs.statSync(f).size, 0);
  const line = { name, ms, peakMB: Math.round(peak), MB: +(size / 1e6).toFixed(2), raceMB: +(fs.statSync(outs[0]).size / 1e6).toFixed(2) };
  console.log("PERF", JSON.stringify(line));
}
