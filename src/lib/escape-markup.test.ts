import { expect, test } from "bun:test";
import { escapeMarkup } from "./escape-markup";

test("escapes every character that can break out of markup", () => {
  expect(escapeMarkup(`<a href="x">Tom & 'Jo'</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jo&apos;&lt;/a&gt;",
  );
});
