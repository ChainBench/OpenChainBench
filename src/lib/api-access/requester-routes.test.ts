import { describe, expect, test } from "bun:test";
import { POST as submit } from "@/app/api/api-access/requests/route";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import { jsonPost } from "@/test/api-access-fixtures";
import { isolateRedisEnv } from "@/test/env";
import { quietConsole } from "@/test/quiet-console";
import { ADMISSIONS, type Admission, requesterGate } from "./http";

const logs = quietConsole();
isolateRedisEnv();

const MAX_CALLS = 100;
const SENDER_WAIT_SEC = 3_000;
type Route = (req: Request) => Promise<Response>;

const from = (address: string, body: unknown) =>
  jsonPost(body, { "x-vercel-forwarded-for": address });

async function callsUntilCapped(route: Route, network: string, body: unknown) {
  for (let i = 1; i <= MAX_CALLS; i += 1) {
    const res = await route(from(`${network}::${i}`, body));
    if (res.status === 429) return i;
  }
  return MAX_CALLS + 1;
}

describe("requester routes", () => {
  const unavailable = { status: 503, error: "not_saved" };
  const cases: [keyof typeof ADMISSIONS, Route, unknown, string][] = [
    ["request", submit, TEST_REQUESTER, "2001:db8:c"],
  ];
  for (const [name, route, body, prefix] of cases) {
    test(`the ${name} route caps one /48, not its neighbours`,
      async () => {
        const capped = await callsUntilCapped(route, `${prefix}:1`, body);
        expect(capped).toBe(ADMISSIONS[name].perNetwork + 1);
        for (let i = 0; i <= ADMISSIONS[name].perInstance; i += 1) {
          await route(from(`${prefix}:1::1`, body));
        }
        const sibling = await route(from(`${prefix}:2::1`, body));
        expect(sibling.status).toBe(429);
        const neighbour = await route(from(`${prefix}1:1::1`, body));
        expect({ status: neighbour.status, ...await neighbour.json() })
          .toEqual(unavailable);
      });
  }

  test("only served calls spend the site's budget", async () => {
    const admission: Admission = {
      route: `busy-${crypto.randomUUID()}`,
      perNetwork: 1,
      perInstance: 1,
    };
    const gate = (address: string) =>
      requesterGate(from(address, {}), admission);
    expect(gate("192.0.2.9").admit()).toBeNull();
    const first = gate("192.0.3.10");
    expect(first.admit()).toBeNull();
    first.served();
    const busy = gate("192.0.4.11").admit();
    expect(busy?.status).toBe(503);
    expect(Number(busy?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await busy?.json()).toMatchObject({ error: "busy" });
    expect(gate("192.0.4.11").admit()?.status).toBe(503);
    expect(logs.warnings()).toHaveBeenCalledTimes(1);
  });

  test("a capped network is refused until its wait ends",
    () => {
      const admission: Admission = {
        route: `capped-${crypto.randomUUID()}`,
        perNetwork: 3,
        perInstance: 1,
      };
      const gate = (address: string) =>
        requesterGate(from(address, {}), admission);
      gate("192.0.2.1").capped(SENDER_WAIT_SEC);
      for (let i = 0; i < MAX_CALLS; i += 1) {
        expect(gate(`192.0.2.${i}`).admit()?.status).toBe(429);
      }
      const refused = gate("192.0.2.9").admit();
      expect(Number(refused?.headers.get("Retry-After")))
        .toBe(SENDER_WAIT_SEC);
      expect(gate("192.0.3.1").admit()).toBeNull();
    });

  test("calls that are never served are still capped", async () => {
    const admission: Admission = {
      route: `tries-${crypto.randomUUID()}`,
      perNetwork: 1,
      perInstance: 1,
    };
    let admitted = 0;
    while (admitted < MAX_CALLS &&
      requesterGate(from(`192.0.${admitted}.1`, {}), admission).admit() ===
        null) {
      admitted += 1;
    }
    expect(admitted).toBeGreaterThan(admission.perInstance);
    expect(admitted).toBeLessThan(MAX_CALLS);
  });
});
