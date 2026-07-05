import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone sub-apps deployed independently (own package.json + Railway
    // config). Each has its own build, lint and typecheck pipeline; scanning
    // them from the main frontend's lint pass caused every unrelated PR to
    // fail on their pre-existing warnings (unescaped entities, no-explicit-any,
    // react-hooks/set-state-in-effect) that the sub-app maintainers can fix
    // in their own dedicated PRs.
    "infrastructure/**",
    "worker/**",
  ]),
]);

export default eslintConfig;
