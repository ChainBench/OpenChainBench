import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import ts from "typescript";
import { writeOrCheck } from "./generated-files";

const dir = path.resolve(__dirname, "../src/lib/api-access");
const HELPERS = ["retry-wait", "status-answers"];
const helpers = HELPERS.map((name) => path.join(dir, `${name}.ts`));
const source = path.join(dir, "status-page.client.ts");
const target = path.join(dir, "status-page.gen.ts");

const transpile = (file: string) =>
  ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
  }).outputText;

const LOCAL_IMPORT = new RegExp(
  `^import \\{[^}]*\\} from "\\./(?:${HELPERS.join("|")})";\\n`,
  "gm",
);
const inlined = helpers
  .map((file) => transpile(file)
    .replace(LOCAL_IMPORT, "")
    .replace(/^export \{\};\n/m, "")
    .replace(/^export (?=function )/gm, ""))
  .join("");
const page = transpile(source)
  .replace(LOCAL_IMPORT, "")
  .replace(/^export \{\};\n/m, "");
const body = inlined + page;
if (/<\/script|import |export /i.test(body)) {
  throw new Error("status page script must stay a plain inline script");
}
const script = `(() => {\n${body}})();\n`;
new Script(script, { filename: "status-page.js" });
const literal = script
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const PALETTE = [
  "paper",
  "paper-soft",
  "ink",
  "ink-soft",
  "ink-muted",
  "rule-strong",
  "accent",
  "accent-soft",
  "bad",
  "bad-text",
];
const globals = readFileSync(
  path.resolve(__dirname, "../src/app/globals.css"), "utf8");

function colours(block: string): Record<string, string> {
  const found = new RegExp(`\\n${block}\\s*\\{([^}]*)\\}`).exec(globals);
  if (!found?.[1]) throw new Error(`globals.css has no ${block} block`);
  const declared = new Map(
    [...found[1].matchAll(/--color-([a-z-]+):\s*([^;]+);/g)]
      .map(([, name = "", value = ""]) => [name, value.trim()]));
  return Object.fromEntries(PALETTE.map((name) => {
    const value = declared.get(name);
    if (!value) throw new Error(`globals.css ${block} has no --color-${name}`);
    return [name, value];
  }));
}

const palette = { light: colours("@theme"), dark: colours("\\.dark") };
const generated =
  `export const STATUS_PAGE_SCRIPT = \`${literal}\`;\n\n` +
  `export const STATUS_PAGE_PALETTE = ${JSON.stringify(palette, null, 2)};\n`;

writeOrCheck([{ target, content: generated }], "pnpm status-page");
