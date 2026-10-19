// One-shot: renders the Intro composition at 1080x1920 for the Short format.
import { renderMedia, selectComposition } from "@remotion/renderer";
const BUNDLE = "/mnt/video-renderer/poc/remotion-bundle";
const comp = await selectComposition({ serveUrl: BUNDLE, id: "Intro", inputProps: { theme: "dark" } });
await renderMedia({
  serveUrl: BUNDLE,
  codec: "h264",
  inputProps: { theme: "dark" },
  imageFormat: "jpeg",
  jpegQuality: 90,
  x264Preset: "veryfast",
  crf: 22,
  chromiumOptions: { gl: "angle" },
  concurrency: 2,
  logLevel: "info",
  composition: { ...comp, width: 1080, height: 1920 },
  outputLocation: "/mnt/video-renderer/poc/public/intro-vertical.mp4",
});
console.log("intro-vertical.mp4 done");
