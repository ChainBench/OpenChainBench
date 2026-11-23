import { expect, test } from "bun:test";
import { uaFamily } from "./analytics-server";

test.each([
  ["Mozilla/5.0 (Macintosh) Chrome/142.0 Safari/537.36", "browser"],
  ["Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", "declared-bot"],
  ["Mozilla/5.0 (X11) HeadlessChrome/142.0 Safari/537.36", "declared-bot"],
  ["LinkedInBot/1.0 (compatible; Mozilla/5.0)", "unfurler"],
  ["ocb-hf-publisher/2.0 (+https://openchainbench.com)", "other"],
])("classifies %s as %s", (agent, family) => {
  expect(uaFamily(agent)).toBe(family);
});
