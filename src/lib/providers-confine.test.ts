import { describe, expect, test } from "bun:test";
import { confineToThisDeploy } from "./providers";
import type { ProviderProfile } from "./providers";

/**
 * The providers blob is built by the worker from the `dev` checkout and read
 * by both deployments, so production can be handed a profile that only makes
 * sense on staging.
 *
 * The first version of this filter dropped appearances on benches that do not
 * exist here, which covers a dev-only bench. It did not cover the other half:
 * a bench that exists on BOTH branches while only dev's copy declares a given
 * provider. That is the normal state while a provider is trialled on staging,
 * and it gave Validation Cloud a production product page crediting six RPC
 * benches whose published tables do not list it.
 *
 * These run against the repo's real specs, so they also fail if someone later
 * adds the provider to main's YAML, which is the moment the page is allowed.
 */

function profile(slug: string, benchSlugs: string[]): ProviderProfile {
  return {
    slug,
    name: slug,
    appearances: benchSlugs.map((b) => ({
      benchmark: { slug: b, category: "RPCs", chainDimensions: [] },
      rank: 2,
    })),
    wins: 0,
    categories: ["RPCs"],
  } as unknown as ProviderProfile;
}

describe("confineToThisDeploy", () => {
  test("keeps a provider this deployment's spec declares", async () => {
    const [kept] = await confineToThisDeploy([profile("alchemy", ["ethereum-rpc"])]);
    expect(kept?.slug).toBe("alchemy");
    expect(kept?.appearances).toHaveLength(1);
  });

  test("drops a provider the bench exists for but does not declare here", async () => {
    // "definitely-not-a-provider" is in no spec, so every appearance it
    // claims on a real bench has to be stripped and the profile dropped.
    const out = await confineToThisDeploy([
      profile("definitely-not-a-provider", ["ethereum-rpc", "base-rpc"]),
    ]);
    expect(out).toHaveLength(0);
  });

  test("keeps the appearances that are declared and drops the rest", async () => {
    const [kept] = await confineToThisDeploy([
      profile("alchemy", ["ethereum-rpc", "aggregator-head-lag"]),
    ]);
    // Alchemy is a declared Ethereum RPC provider and is not in the
    // aggregator bench, so exactly one appearance survives.
    expect(kept?.appearances.map((a) => a.benchmark.slug)).toEqual(["ethereum-rpc"]);
  });

  test("drops appearances on benches this deployment does not serve at all", async () => {
    const out = await confineToThisDeploy([
      profile("alchemy", ["ethereum-rpc", "a-bench-that-does-not-exist"]),
    ]);
    expect(out[0]?.appearances.map((a) => a.benchmark.slug)).toEqual(["ethereum-rpc"]);
  });
});
