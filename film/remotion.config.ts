import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// The render box has no GPU, so WebGL has to go through software ANGLE or the
// three.js scenes fail with "Error creating WebGL context".
Config.setChromiumOpenGlRenderer("swangle");
