import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Generated = { target: string; content: string };

export function writeOrCheck(files: Generated[], command: string): void {
  const check = process.argv.includes("--check");
  const stale = files.filter(({ target, content }) => {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current === content) return false;
    if (!check) writeFileSync(target, content);
    return true;
  });
  const names = stale
    .map(({ target }) => path.relative(process.cwd(), target))
    .join(", ");
  if (check && stale.length > 0) {
    console.error(`${names} stale. Run \`${command}\` and commit the result.`);
    process.exit(1);
  }
  console.log(stale.length > 0 ? `updated ${names}` : "up to date");
}
