import { describe, expect, test } from "bun:test";
import { failureText } from "@/app/api-access/failure-text";
import type { SiteFailure } from "@/lib/api-access";
import { teamRefusalSchema } from "@/lib/api-access-contract/team-contract";

const MAYBE = "may or may not have been applied";
const UNCHANGED = /nothing was changed/i;

const UNSURE: readonly SiteFailure[] = [
  "unreachable",
  "unavailable",
  "bad_answer",
  "site_error",
];
const UNCHANGED_FAILURES: readonly SiteFailure[] = [
  "unconfigured",
  "unauthorized",
  "redirected",
  "no_route",
];

describe("a failed CRM action", () => {
  test.each([...UNSURE])("after %s, says it may have been applied",
    (failure) => {
      const text = failureText(failure, "approve");
      expect(text).toContain(MAYBE);
      expect(text).not.toMatch(UNCHANGED);
    });

  test.each([...UNCHANGED_FAILURES])("after %s, says nothing changed",
    (failure) => {
      const text = failureText(failure, "approve");
      expect(text).toMatch(UNCHANGED);
      expect(text).not.toContain(MAYBE);
    });

  test.each([...UNSURE])(
    "after %s, a new link is asked again",
    (failure) => {
      const text = failureText(failure, "reissue_link");
      expect(text).toContain("replace the status link again");
      expect(text).not.toContain(MAYBE);
    },
  );

  test.each(teamRefusalSchema.shape.error.options)(
    "refused as %s, says nothing changed",
    (refusal) => {
      expect(failureText(refusal, "approve")).toMatch(UNCHANGED);
    },
  );
});
