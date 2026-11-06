import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const OFFSITE_URL =
  String.raw`/^https?:\x2F\x2F(?!([\w-]+\.)*(openchainbench\.com|doi\.org|creativecommons\.org)([\x2F:?#]|$))/`;
const OFFSITE_HREF_VALUES = [
  `Literal[value=${OFFSITE_URL}]`,
  `JSXExpressionContainer > Literal[value=${OFFSITE_URL}]`,
  `JSXExpressionContainer > TemplateLiteral > TemplateElement:first-child[value.raw=${OFFSITE_URL}]`,
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/app/api/**",
      "src/lib/outbound-click.ts",
      "src/lib/utm.test.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/utm"],
          importNames: ["withUtm"],
          message:
            "Use OutboundLink or outboundHref: withUtm alone skips the count on /go.",
        }],
      }],
      "no-restricted-syntax": ["error",
        ...OFFSITE_HREF_VALUES.map((value) => ({
          selector: `JSXOpeningElement[name.name!='OutboundLink'] > JSXAttribute[name.name='href'] > ${value}`,
          message: "A link to another site goes through OutboundLink, so its opening is counted.",
        })),
        {
          selector: "JSXOpeningElement[name.name='Link'] > JSXAttribute[name.name='href'] CallExpression[callee.name='outboundHref']",
          message: "next/link prefetches its href. Render /go through OutboundLink.",
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='open']",
          message: "Use openOutbound, so the opening is counted and the referrer kept.",
        },
      ],
    },
  },
  {
    files: [
      "src/components/speedtest/speedtest-rpc-client.tsx",
      "src/lib/speedtest/rpc-directory.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/utm", "**/outbound-click", "**/outbound-link"],
          message:
            "RPC endpoints are copied into configs: they stay clean, with no tag and no /go.",
        }],
      }],
    },
  },
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
    "video/**",
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
