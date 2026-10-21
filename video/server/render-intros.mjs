// Rebuild public/intro.mp4 and public/intro-vertical.mp4 whenever the Intro
// composition changes. The server concatenates these pre-rendered files in
// front of every export, and the deploy ships public/ from git, so the new
// files are rendered, then committed.
//   lab box (from video/):  node server/render-intros.mjs public swangle
//   renderer box:           node render-intros.mjs  (defaults below)
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import { bundle } from "@remotion/bundler";
import path from "node:path";
const [outArg, glArg] = process.argv.slice(2);
const PUBLIC = outArg ?? "/mnt/video-renderer/poc/public";
const GL = glArg ?? "angle";
const BUNDLE = outArg ? await bundle({ entryPoint: path.resolve("src/index.ts") }) : "/mnt/video-renderer/poc/remotion-bundle";
const puppeteerInstance = await openBrowser("chrome", { chromiumOptions: { gl: GL } });
const inputProps = { theme: "dark" };
const comp = await selectComposition({ serveUrl: BUNDLE, id: "Intro", inputProps, puppeteerInstance });
for (const [file, width, height] of [["intro.mp4", 1920, 1080], ["intro-vertical.mp4", 1080, 1920]]) {
  await renderMedia({
    serveUrl: BUNDLE,
    codec: "h264",
    inputProps,
    puppeteerInstance,
    // Same settings as the server's segments, so the concat stays -c copy.
    imageFormat: "jpeg",
    jpegQuality: 95,
    x264Preset: "veryfast",
    crf: 18,
    ffmpegOverride: ({ args }) => {
      const i = args.indexOf("-crf");
      return i < 0 ? args : [...args.slice(0, i), "-tune", "animation", ...args.slice(i)];
    },
    colorSpace: "bt709",
    chromiumOptions: { gl: GL },
    concurrency: 2,
    logLevel: "warn",
    composition: { ...comp, width, height },
    outputLocation: `${PUBLIC}/${file}`,
  });
  console.log(file, "done");
}
await puppeteerInstance.close({ silent: true });
