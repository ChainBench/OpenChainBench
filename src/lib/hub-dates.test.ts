import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_PUBLISHED, datedCollectionLd, hubDateModified } from "./hub-dates";

/**
 * Six hubs served measurements with no date at all.
 *
 * Measured from the served HTML on 2026-10-20: /rpc 200 values, /benchmarks
 * 195, /trading-apps 171, /bridge 78, /trading-agents 48, /data-api 40, and
 * not one of them published a datePublished or a dateModified. Every one
 * already had the timestamp in hand and never passed it to its JSON-LD.
 */
describe("a hub states when its numbers were true", () => {
  test("the date is the stalest of the page's stamps, not the freshest", () => {
    // /bridge shows two benches as one board. Taking the newer presented a
    // bench last read at 21:43 as if it had been read at 21:48.
    expect(
      hubDateModified(["2026-10-19T21:48:59Z", "2026-10-19T21:43:34Z"]),
    ).toBe("2026-10-19T21:43:34Z");
  });

  test("nulls, blanks and junk are dropped rather than ordered", () => {
    expect(hubDateModified([null, undefined, "", "not a date"])).toBeNull();
    expect(hubDateModified(["not a date", "2026-10-19T10:00:00Z"])).toBe(
      "2026-10-19T10:00:00Z",
    );
    expect(hubDateModified([])).toBeNull();
  });

  test("no stamp means no date, never the render time", () => {
    // A date that is actually the clock says the page changed when nothing
    // did, which is the claim this whole change exists to remove.
    const ld = datedCollectionLd({
      path: "/rpc",
      url: "https://openchainbench.com/rpc",
      name: "x",
      itemList: { "@type": "ItemList", numberOfItems: 1 },
      dateModified: null,
    });
    const page = (ld["@graph"] as Record<string, unknown>[])[0];
    expect(page.dateModified).toBeUndefined();
    // The pinned publication date still applies: it does not depend on data.
    expect(page.datePublished).toBe("2026-07-03");
  });

  test("the ItemList moves under the page and loses its own @context", () => {
    const ld = datedCollectionLd({
      path: "/bridge",
      url: "https://openchainbench.com/bridge",
      name: "Cross-chain bridge benchmarks by OpenChainBench",
      itemList: {
        "@context": "https://schema.org",
        "@type": "ItemList",
        numberOfItems: 8,
      },
      dateModified: "2026-10-19T21:43:34Z",
    });
    expect(ld["@context"]).toBe("https://schema.org");
    const page = (ld["@graph"] as Record<string, unknown>[])[0];
    expect(page["@type"]).toBe("CollectionPage");
    const list = page.mainEntity as Record<string, unknown>;
    expect(list["@type"]).toBe("ItemList");
    expect(list["@context"]).toBeUndefined();
    expect(page.dateModified).toBe("2026-10-19T21:43:34Z");
  });

  test("isPartOf points at the WebSite node the layout actually emits", () => {
    // Guessing the id would make isPartOf dangle, which is worse than leaving
    // it out. The layout emits `${SITE.url}/#site`.
    const layout = readFileSync(
      join(import.meta.dir, "..", "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain('"@id": `${SITE.url}/#site`');
    const ld = datedCollectionLd({
      path: "/rpc",
      url: "https://openchainbench.com/rpc",
      name: "x",
      itemList: { "@type": "ItemList" },
      dateModified: null,
    });
    const page = (ld["@graph"] as Record<string, unknown>[])[0];
    expect((page.isPartOf as Record<string, string>)["@id"]).toBe(
      "https://openchainbench.com/#site",
    );
  });

  test("every hub that shows numbers has a pinned publication date", () => {
    for (const path of [
      "/benchmarks",
      "/rpc",
      "/bridge",
      "/data-api",
      "/trading-apps",
      "/trading-agents",
      "/capital",
      "/rwa",
      "/perps",
    ]) {
      expect(HUB_PUBLISHED[path], `${path} has no pinned date`).toMatch(
        /^20\d\d-\d\d-\d\d$/,
      );
    }
  });

  test("the pinned dates are not in the future and not before the site", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const [path, d] of Object.entries(HUB_PUBLISHED)) {
      expect(d <= today, `${path} is dated in the future`).toBe(true);
      // The site's own founding date. A hub cannot predate the site.
      expect(d >= "2026-04-28", `${path} predates the site`).toBe(true);
    }
  });

  test("the Dataset hubs carry a publication date too", () => {
    // E2 after the first round: 3 of 9 numeric pages still had none, and they
    // were the three that emit a Dataset node instead of an ItemList, so the
    // CollectionPage wrapper never reached them. /capital shows 858 values.
    for (const [route, key] of [["capital", "/capital"], ["rwa", "/rwa"]]) {
      const src = readFileSync(
        join(import.meta.dir, "..", "app", route, "page.tsx"),
        "utf8",
      );
      expect(src, route + " has no datePublished").toContain(
        'datePublished: HUB_PUBLISHED["' + key + '"]',
      );
    }
    const ds = readFileSync(join(import.meta.dir, "dataset-jsonld.ts"), "utf8");
    expect(ds).toContain("datePublished: DATASET_PUBLISHED");
  });

  test("the six wired hubs derive the date instead of hard-coding one", () => {
    for (const route of [
      "rpc",
      "bridge",
      "data-api",
      "trading-apps",
      "trading-agents",
      "benchmarks",
    ]) {
      const src = readFileSync(
        join(import.meta.dir, "..", "app", route, "page.tsx"),
        "utf8",
      );
      expect(src, `${route} does not wrap its ItemList`).toContain(
        "datedCollectionLd({",
      );
      // A literal date in the call is the drift this file exists to prevent.
      const call = src.slice(src.indexOf("datedCollectionLd({"));
      expect(call.slice(0, 400)).not.toMatch(/dateModified:\s*"20\d\d-/);
    }
  });
});
