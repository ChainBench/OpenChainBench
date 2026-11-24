import { readFileSync } from "node:fs";
import path from "node:path";
import { writeOrCheck } from "./generated-files";

const root = path.resolve(__dirname, "..");
const FILES = ["contract.ts", "team-contract.ts"];
const from = path.join(root, "src/lib/api-access");
const to = path.join(root, "crm/lib/api-access-contract");

writeOrCheck(
  FILES.map((file) => ({
    target: path.join(to, file),
    content: readFileSync(path.join(from, file), "utf8"),
  })),
  "pnpm contract:crm",
);
