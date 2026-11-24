import { expect, test } from "bun:test";
import { STATUS_TOKEN } from "./contract";
import { API_KEY_PATTERN, newApiKey, newStatusToken } from "./secrets";

const DRAWS = 1000;
const MIN_LEADING_CHARS = 30;

const draws = (draw: () => string) =>
  Array.from({ length: DRAWS }, () => draw());

test.each([
  ["key", newApiKey, API_KEY_PATTERN, "ocb_".length],
  ["status token", newStatusToken, STATUS_TOKEN, 0],
])("every %s is unique and uses the full length", (_, draw, shape, at) => {
  const drawn = draws(draw);
  for (const secret of drawn) expect(secret).toMatch(shape);
  expect(new Set(drawn).size).toBe(DRAWS);
  const leading = new Set(drawn.map((secret) => secret.charAt(at)));
  expect(leading.size).toBeGreaterThan(MIN_LEADING_CHARS);
});
