import { describe, expect, it } from "bun:test";

import { isSelectablePanelView, resolvePanelView } from "@/lib/panel-view";

/**
 * The case these tests exist for, in full, because it is the reason the rule
 * was extracted rather than duplicated.
 *
 * Bench 311 publishes a capability matrix. A provider we could not ask gets
 * no series at all, and the ledger columns render that absence as a dash.
 * Selecting a panel switches the board to one value per row through
 * pickValue, which coerces a missing reading to 0, so the same absence became
 * "0%", which reads as the provider refusing. The panels were declared
 * `tab: false` to remove the tabs, but `?view=` validated only that the id
 * existed, so the view was still reachable by URL and would still publish a
 * refusal nobody received.
 */
describe("resolvePanelView", () => {
  const panels = [
    { id: "api_trace_block", tab: false },
    { id: "api_archive_5m", tab: false },
    { id: "latency_p50" }, // tab undefined, so selectable
    { id: "users", tab: true },
  ];

  it("refuses a data-only panel named in the URL", () => {
    expect(resolvePanelView("api_trace_block", panels)).toBeNull();
    expect(resolvePanelView("api_archive_5m", panels)).toBeNull();
  });

  it("accepts a panel that declares tab true", () => {
    expect(resolvePanelView("users", panels)).toBe("users");
  });

  it("accepts a panel that declares no tab at all, the default", () => {
    expect(resolvePanelView("latency_p50", panels)).toBe("latency_p50");
  });

  it("refuses an id no panel carries, as it already did", () => {
    expect(resolvePanelView("dropped_between_deploys", panels)).toBeNull();
  });

  it("returns null with no view parameter", () => {
    expect(resolvePanelView(null, panels)).toBeNull();
    expect(resolvePanelView("", panels)).toBeNull();
  });

  it("returns null when the bench publishes no panels", () => {
    expect(resolvePanelView("anything", [])).toBeNull();
  });

  it("does not confuse a data-only id with a selectable one of similar name", () => {
    const mixed = [{ id: "trace", tab: false }, { id: "trace_7d", tab: true }];
    expect(resolvePanelView("trace", mixed)).toBeNull();
    expect(resolvePanelView("trace_7d", mixed)).toBe("trace_7d");
  });
});

describe("isSelectablePanelView", () => {
  it("treats only an explicit false as data-only", () => {
    expect(isSelectablePanelView({ tab: false })).toBe(false);
    expect(isSelectablePanelView({ tab: true })).toBe(true);
    // Undefined must stay selectable: the vast majority of panels across the
    // specs declare no tab field and have always rendered a tab. Reading
    // undefined as data-only would silently remove every chart on the site.
    expect(isSelectablePanelView({})).toBe(true);
    expect(isSelectablePanelView({ tab: undefined })).toBe(true);
  });
});
