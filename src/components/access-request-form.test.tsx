import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { REQUEST_ROUTE, SECRET_CHARS } from "@/lib/api-access/contract";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import { sendRequest } from "./access-request-answer";
import { AccessRequestForm } from "./access-request-form";

const realFetch = globalThis.fetch;
const token = "A".repeat(SECRET_CHARS);
afterEach(() => {
  globalThis.fetch = realFetch;
});

function siteAnswering(status: number, body: unknown) {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json(body, { status });
  }, { preconnect: realFetch.preconnect });
  return calls;
}

describe("AccessRequestForm", () => {
  test("before its script runs, it cannot be sent and says why", () => {
    const html = renderToStaticMarkup(
      <AccessRequestForm contactEmail="team@example.com" />,
    );
    const submit = /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";
    expect(submit).toContain('disabled=""');
    expect(html).toContain("The form is still loading");
    expect(html).toContain('href="mailto:team@example.com"');
  });

  test("a stored request leads to its private status link", async () => {
    const calls = siteAnswering(201, { token });
    expect(await sendRequest({ ...TEST_REQUESTER })).toEqual(
      { kind: "sent", link: `/api-access/status#${token}` });
    expect(calls).toEqual([REQUEST_ROUTE]);
  });

  test.each([
    ["no token", {}],
    ["a token with a path after it", { token: `${token}/x` }],
    ["a token with a page before it", { token: `x/${token}` }],
  ])("a 201 with %s is not taken as sent", async (_, body) => {
    siteAnswering(201, body);
    expect(await sendRequest({ ...TEST_REQUESTER })).toMatchObject(
      { kind: "editing", refusal: { kind: "unconfirmed" } });
  });
});
