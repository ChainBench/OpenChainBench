import { describe, expect, test } from "bun:test";
import { declineText, tallyDeclines } from "@/app/api-access/decline-report";
import type { Acted } from "@/lib/api-access";
import { ROW } from "./team-view";

const done: Acted = { ok: true, request: ROW, link: null };
const failed = (error: Extract<Acted, { ok: false }>["error"]): Acted => ({
  ok: false,
  error,
});

describe("spam decline tally", () => {
  test("all declined is complete", () => {
    expect(tallyDeclines(2, [done, done])).toEqual({
      declined: 2,
      settled: 0,
      refused: [],
      unsure: [],
      untried: 0,
      complete: true,
    });
  });

  test("requests decided elsewhere still count as complete", () => {
    const tally = tallyDeclines(
      3,
      [done, failed("illegal_transition"), failed("not_found")],
    );
    expect(tally).toMatchObject({ declined: 1, settled: 2, complete: true });
  });

  test("a request changed at the same moment is not declined", () => {
    const tally = tallyDeclines(2, [failed("conflict"), failed("not_found")]);
    expect(tally).toMatchObject({
      declined: 0,
      settled: 1,
      refused: [["conflict", 1]],
      complete: false,
    });
  });

  test("an unsure or untried request leaves the batch incomplete", () => {
    expect(tallyDeclines(3, [done, failed("unreachable"),
      failed("site_error")])).toMatchObject({
      declined: 1,
      unsure: ["unreachable", "site_error"],
      complete: false,
    });
    expect(tallyDeclines(3, [done]))
      .toMatchObject({ untried: 2, complete: false });
  });

  test("refused, unsure and untried requests are each counted", () => {
    const tally = tallyDeclines(10, [
      done,
      failed("invalid"),
      failed("unreachable"),
      failed("unauthorized"),
      failed("invalid"),
    ]);
    expect(tally).toEqual({
      declined: 1,
      settled: 0,
      refused: [["invalid", 2], ["unauthorized", 1]],
      unsure: ["unreachable"],
      untried: 5,
      complete: false,
    });
  });

  test("a partly declined batch never says nothing changed", () => {
    const text = declineText(tallyDeclines(3,
      [done, failed("unauthorized"), failed("unreachable")]));
    expect(text).not.toMatch(/nothing was changed/i);
    expect(text.match(/may or may not/g)).toHaveLength(1);
  });

  test("an unsure batch never says none was declined", () => {
    const text = declineText(tallyDeclines(1, [failed("unreachable")]));
    expect(text).not.toMatch(/no request was declined/i);
  });
});
