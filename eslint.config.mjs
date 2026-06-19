import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Catches `parseInt(x)` without a radix — defaults to 10 in modern
      // engines but readers can't tell whether a hex string was intended.
      radix: "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vercel build artifacts (lint shouldn't crawl them during `vercel dev`).
    ".vercel/**",
    // The Railway materialize worker is a long-lived Node process, not
    // part of the Next bundle. Linting it under the same Next config
    // surfaces false positives for `eslint-plugin-react` etc., and the
    // worker is tested via `tsc --noEmit` like the rest of the repo.
    "worker/**",
    // CLI scripts run via `tsx`, never bundled into Next pages.
    "scripts/**",
  ]),
]);

export default eslintConfig;
