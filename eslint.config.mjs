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
    "crm/**",
    // Background agents check the repo out into .claude/worktrees, so a
    // local `pnpm lint` walked every copy as if it were source. On
    // 2026-09-30 that turned 0 errors and 9 warnings into 5,085 errors and
    // 72,199 warnings across 1,579 files, none of them this repo's code.
    // CI never saw it because CI lints a fresh clone, so the local signal
    // was the only one that was broken, and it was broken badly enough to
    // be useless. Not a build artifact directory, hence the explicit entry.
    ".claude/**",
  ]),
]);

export default eslintConfig;
