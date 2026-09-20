import { describe, expect, test } from "bun:test";
import { pageKeyStripper } from "../lib/gsc";

describe("pageKeyStripper", () => {
  test("domain property: every host and scheme of the domain", () => {
    const strip = pageKeyStripper("sc-domain:openchainbench.com");
    expect(strip("https://openchainbench.com/benchmarks/bridge-fee")).toBe("/benchmarks/bridge-fee");
    expect(strip("https://www.openchainbench.com/rpc")).toBe("/rpc");
    expect(strip("http://openchainbench.com/")).toBe("/");
    expect(strip("https://staging.openchainbench.com/x")).toBe("/x");
    expect(strip("https://example.com/openchainbench.com")).toBe("https://example.com/openchainbench.com");
  });
  test("url-prefix property", () => {
    const strip = pageKeyStripper("https://openchainbench.com/");
    expect(strip("https://openchainbench.com/compare/a-vs-b")).toBe("/compare/a-vs-b");
  });
});
