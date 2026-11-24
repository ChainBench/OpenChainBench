import { describe, expect, test } from "bun:test";
import { isolateEnv } from "@/test/env";
import {
  type BearerCheck,
  checkBearer,
  cronAuthorized,
} from "./internal-bearer";

const NAME = "TEST_INTERNAL_SECRET";

const withHeader = (value?: string): Request =>
  new Request("https://example.test/api/internal/x", {
    method: "POST",
    headers: value === undefined ? {} : { authorization: value },
  });

const setMode = (mode: string) =>
  Object.assign(process.env, { NODE_ENV: mode });

isolateEnv([NAME, `${NAME}_NEXT`, "CRON_SECRET", "NODE_ENV"]);

describe("checkBearer", () => {
  test("is unconfigured without a secret", () => {
    expect(checkBearer(withHeader("Bearer anything"), [NAME])).toBe(
      "unconfigured",
    );
  });

  const cases: [string, string | undefined, BearerCheck][] = [
    ["matching secret", "Bearer s3cret-value", "authorized"],
    ["wrong secret", "Bearer s3cret-valuX", "unauthorized"],
    ["prefix of the secret", "Bearer s3cret", "unauthorized"],
    ["secret without the scheme", "s3cret-value", "unauthorized"],
    ["no header", undefined, "unauthorized"],
  ];
  for (const [name, header, expected] of cases) {
    test(name, () => {
      process.env[NAME] = "s3cret-value\n";
      expect(checkBearer(withHeader(header), [NAME])).toBe(expected);
    });
  }

  test("accepts each named secret, and only those", () => {
    process.env[NAME] = "current-secret";
    process.env[`${NAME}_NEXT`] = "next-secret";
    const both = [NAME, `${NAME}_NEXT`] as const;
    expect(checkBearer(withHeader("Bearer next-secret"), both))
      .toBe("authorized");
    expect(checkBearer(withHeader("Bearer current-secret"), both))
      .toBe("authorized");
    expect(checkBearer(withHeader("Bearer next-secret"), [NAME]))
      .toBe("unauthorized");
  });

  test("the next secret alone does not open the route", () => {
    process.env[`${NAME}_NEXT`] = "next-secret";
    const both = [NAME, `${NAME}_NEXT`] as const;
    expect(checkBearer(withHeader("Bearer next-secret"), both))
      .toBe("unconfigured");
  });
});

describe("cronAuthorized", () => {
  test("without a secret, open outside production", () => {
    setMode("development");
    expect(cronAuthorized(withHeader())).toBe(true);
  });

  test("accepts the cron secret's bearer", () => {
    process.env.CRON_SECRET = "cron-secret";
    expect(cronAuthorized(withHeader("Bearer cron-secret"))).toBe(true);
  });
});
