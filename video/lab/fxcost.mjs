// Per-frame cost of each effect: 90 frames per (composition, labOff) pair,
// one shared browser, concurrency 2, jpeg 90. Run under taskset with 2 cores.
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";
const [fx, outDir] = process.argv.slice(2);
const bench = JSON.parse(fs.readFileSync(fx, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const browser = await openBrowser("chrome", { chromiumOptions: { gl: "swangle" } });
const fmt = process.env.FMT === "short" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
for (const id of ["Outro", "BarChartRace", "TimeSeriesRace"]) {
  for (const off of ["", "kb", "vig", "glow", "tshadow", "kb,vig,glow,tshadow"]) {
    if (id === "Outro" && off) continue;
    const inputProps = { theme: "dark", bench, labOff: off };
    const comp = await selectComposition({ serveUrl, id, inputProps, puppeteerInstance: browser });
    const t0 = Date.now();
    await renderMedia({ serveUrl, codec: "h264", inputProps, puppeteerInstance: browser, composition: { ...comp, ...fmt, durationInFrames: Math.max(comp.durationInFrames, 300) },
      frameRange: [100, 189], imageFormat: "jpeg", jpegQuality: 90, x264Preset: "veryfast", crf: 19, concurrency: 2, logLevel: "error",
      outputLocation: path.join(outDir, `${id}-${off || "all-on"}.mp4`) });
    console.log("FX", id, off || "(all on)", ((Date.now() - t0) / 90).toFixed(0), "ms/frame");
  }
}
await browser.close({ silent: true });
