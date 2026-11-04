import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A declared FAQ question must be visible to a reader.
 *
 * The October private RPC report carried five questions in its frontmatter
 * and re-typed four of them in the body. The fifth, about `trace_block`,
 * therefore existed only in the JSON-LD: it was offered to answer engines
 * and never shown to anyone. A later edit then corrected a figure inside
 * that hidden answer (Dwellir 50.0 to 42.9 per cent) and shipped the
 * correction invisible.
 *
 * The harm is the hidden question, not the duplication, so that is what is
 * asserted here. Four other reports re-type their questions in the body;
 * they are not failing this test because their readers do see every
 * question. They carry the drift risk, and `<Faq />` is the way out of it.
 */
const DIR = join(import.meta.dir, "../../content/reports");

function reportFiles(): string[] {
  const out: string[] = [];
  for (const cat of readdirSync(DIR, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    for (const f of readdirSync(join(DIR, cat.name))) {
      if (f.endsWith(".mdx")) out.push(join(DIR, cat.name, f));
    }
  }
  return out;
}

function frontmatterQuestions(src: string): string[] {
  const end = src.indexOf("\n---", 4);
  const head = end === -1 ? "" : src.slice(0, end);
  return [...head.matchAll(/^\s+- q: "((?:[^"\\]|\\.)*)"/gm)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  );
}

describe("a report's declared FAQ reaches the reader", () => {
  test("no question is published to JSON-LD alone", () => {
    const hidden: string[] = [];
    for (const file of reportFiles()) {
      const src = readFileSync(file, "utf8");
      const qs = frontmatterQuestions(src);
      if (qs.length === 0) continue;
      const end = src.indexOf("\n---", 4);
      const body = end === -1 ? src : src.slice(end);
      // `<Faq />` renders every entry, so the report is covered wholesale.
      if (body.includes("<Faq />")) continue;
      for (const q of qs) {
        if (!body.includes(q)) hidden.push(`${file.split("/").pop()}: ${q}`);
      }
    }
    expect(
      hidden,
      [
        "These FAQ questions are declared in frontmatter, reach the page's",
        "JSON-LD, and appear nowhere a reader can see them. An answer engine",
        "is offered text the page does not show.",
        "",
        "Render the report's FAQ with <Faq />, which draws from the same",
        "frontmatter as the structured data, instead of re-typing questions",
        "in the body and forgetting one.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("<Faq /> and a hand-typed copy are not both present", () => {
    // Belt and braces: a report that adopts <Faq /> and keeps its old copy
    // would show every question twice.
    const doubled: string[] = [];
    for (const file of reportFiles()) {
      const src = readFileSync(file, "utf8");
      const end = src.indexOf("\n---", 4);
      const body = end === -1 ? src : src.slice(end);
      if (!body.includes("<Faq />")) continue;
      for (const q of frontmatterQuestions(src)) {
        if (body.includes(`### ${q}`)) doubled.push(`${file.split("/").pop()}: ${q}`);
      }
    }
    expect(doubled, "A question is rendered by <Faq /> and re-typed below it.").toEqual([]);
  });
});
