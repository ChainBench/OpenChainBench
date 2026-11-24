import { describe, expect, test } from "bun:test";
import { readAccessForm } from "@/app/api-access/action-form";
import { MAX_PENDING } from "@/lib/api-access-contract/contract";

const ID = crypto.randomUUID();

function form(fields: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  return data;
}

describe("access action form", () => {
  test("an action on one request names it", () => {
    expect(readAccessForm(form([["action", "approve"], ["id", ID]])))
      .toEqual({ kind: "act", id: ID, action: { action: "approve" } });
    expect(readAccessForm(form([
      ["action", "decline"], ["id", ID], ["reason", "Personal project"],
    ]))).toEqual({
      kind: "act",
      id: ID,
      action: { action: "decline", reason: "Personal project" },
    });
  });

  test("declining without a reason is refused by name", () => {
    const noReason: [string, string][][] = [[], [["reason", "  \n "]]];
    for (const reason of noReason) {
      const fields = form([["action", "decline"], ["id", ID], ...reason]);
      expect(readAccessForm(fields)).toEqual({
        kind: "unreadable",
        message: "A reason is needed to decline. Nothing was changed.",
      });
    }
  });

  test("a form that does not name one request is unreadable", () => {
    const cases: [string, string][][] = [
      [["action", "approve"], ["id", "../admin"]],
      [["action", "delete"], ["id", ID]],
      [["action", "approve"]],
    ];
    for (const fields of cases) {
      expect(readAccessForm(form(fields)).kind).toBe("unreadable");
    }
  });

  test("declining as spam takes every selected request", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const fields: [string, string][] = [
      ["action", "decline_spam"],
      ...ids.map((id): [string, string] => ["ids", id]),
    ];
    expect(readAccessForm(form(fields)))
      .toEqual({ kind: "decline_spam", ids });
  });

  test("a spam decline with no or too many requests is unreadable", () => {
    const tooMany = Array.from({ length: MAX_PENDING + 1 },
      (): [string, string] => ["ids", crypto.randomUUID()]);
    const cases: [string, string][][] = [[], tooMany, [["ids", "x"]]];
    for (const ids of cases) {
      const read = readAccessForm(form([["action", "decline_spam"], ...ids]));
      expect(read.kind).toBe("unreadable");
    }
  });
});
