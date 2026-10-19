/**
 * Bundles the Remotion entry point into ./remotion-bundle/ so the Next.js
 * /api/render route can serve it via @remotion/renderer without importing
 * @remotion/bundler at request time. The bundler ships rspack + esbuild
 * native bindings (.node files) which webpack refuses to parse, so it
 * must be kept out of the Next bundle entirely — official Remotion stance:
 * https://www.remotion.dev/docs/miscellaneous/nextjs
 *
 * Re-run this whenever a composition file under src/ changes; the dev
 * script runs it once before `next dev` boots.
 */

import { bundle } from "@remotion/bundler";
import path from "node:path";
import { rm, cp } from "node:fs/promises";

const OUT = path.resolve("remotion-bundle");

await rm(OUT, { recursive: true, force: true });

const tmp = await bundle({
  entryPoint: path.resolve("src/index.ts"),
});

await cp(tmp, OUT, { recursive: true });
console.log(`Remotion bundle ready at ${OUT}`);
