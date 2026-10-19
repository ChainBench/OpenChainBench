import { Config } from "@remotion/cli/config";

// Higher quality H.264 baseline. CRF 17 is visually lossless; bump down
// to 14 if Twitter's re-encode is producing artefacts.
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);

// Critical for three.js scenes: use ANGLE so software-WebGL renders the
// scene on the headless Chromium without needing a GPU. Without this,
// the canvas comes back blank on Lambda.
Config.setChromiumOpenGlRenderer("angle");

// Concurrency: 1 keeps memory usage predictable while iterating locally.
// Lambda overrides this per-invocation via inputProps.
Config.setConcurrency(1);

// Pixel format that Twitter / X auto-decodes without re-encoding from
// the wrong colour primary. yuv420p is the universal compatibility pick.
Config.setPixelFormat("yuv420p");

// Codec is selected on the CLI via --codec h264 in package.json scripts;
// Config.setVideoCodec is not exposed in this version.
