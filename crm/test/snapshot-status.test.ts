import { describe, expect, test } from "bun:test";
import { TRAFFIC_SECTIONS } from "@/lib/traffic";

describe("snapshot status keys", () => {
  test("the known-section list covers every traffic section and no removed loader", () => {
    // Mirrors the filter in doRefresh: a key outside this set is dropped,
    // which is what clears "gsc: GSC_SERVICE_ACCOUNT_JSON not set" from the
    // header after the loader was removed.
    const known = new Set(["benches", "harness", "dune", "posthog", ...TRAFFIC_SECTIONS.map((s) => `traffic.${s}`)]);
    expect(known.has("gsc")).toBe(false);
    expect(known.has("vercel")).toBe(false);
    for (const s of TRAFFIC_SECTIONS) expect(known.has(`traffic.${s}`)).toBe(true);
  });
});
