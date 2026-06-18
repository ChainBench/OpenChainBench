/**
 * Shape-bump regression test for MaterializedSnapshotSchema.
 *
 * The owner has been burned 10+ times by adding a field to a cached/stored
 * payload without bumping the cache key or updating the parsing schema. The
 * snapshot envelope is the source of truth for what the worker writes and
 * the site reads, so its zod schema MUST cover every required field.
 *
 * Strategy:
 *   - snapshot-current.json: a fixture that matches the schema as of HEAD.
 *     If anyone changes the schema in an incompatible way without updating
 *     the fixture, this test fails -> the canary fires.
 *   - explicit "old shape" test: a payload missing the `state` field that
 *     was added when carry-forward shipped. Parsing must return null so we
 *     know strict validation is enforced (not "anything goes via z.unknown").
 */
import { describe, expect, test } from "bun:test";
import fixture from "./__fixtures__/snapshot-current.json";
import { MAT_SCHEMA_VERSION, matKeys, parseSnapshot } from "./schema";

describe("MaterializedSnapshotSchema", () => {
  test("parses the current-shape fixture", () => {
    const snap = parseSnapshot(JSON.stringify(fixture));
    expect(snap).not.toBeNull();
    expect(snap?.v).toBe(MAT_SCHEMA_VERSION);
    expect(snap?.slug).toBe("test-bench");
    expect(snap?.sig).toBe("chain=ethereum");
    expect(snap?.state.providers["alchemy"]?.observedAt).toBe(1718711000000);
    expect(snap?.state.providers["infura"]?.staleSince).toBe(1718710000000);
    expect(snap?.state.rings["alchemy"]?.["24h"]?.points).toEqual([
      1.0,
      2.0,
      null,
      3.5,
    ]);
  });

  test("rejects an old-shape snapshot missing the carry-forward state field", () => {
    // Pre-state shape (early v1 envelope before WorkerStateSchema). If
    // someone re-introduces this shape by accident the worker would write
    // unreadable blobs, so parseSnapshot must refuse it.
    const oldShape = {
      v: 1,
      slug: "test-bench",
      sig: "",
      builtAt: 1718712000000,
      bench: {},
    };
    expect(parseSnapshot(JSON.stringify(oldShape))).toBeNull();
  });

  test("rejects a snapshot whose version literal drifts", () => {
    const drifted = { ...fixture, v: 999 };
    expect(parseSnapshot(JSON.stringify(drifted))).toBeNull();
  });

  test("rejects malformed JSON without throwing", () => {
    expect(parseSnapshot("not json")).toBeNull();
    expect(parseSnapshot("")).toBeNull();
  });

  test("rejects a snapshot with non-numeric ring points (would break renderer math)", () => {
    const bad = JSON.parse(JSON.stringify(fixture));
    bad.state.rings.alchemy["24h"].points = [1, "oops", 3];
    expect(parseSnapshot(JSON.stringify(bad))).toBeNull();
  });
});

describe("matKeys", () => {
  test("uses MAT_SCHEMA_VERSION in every key", () => {
    expect(matKeys.heartbeat).toBe(`ocb:mat:v${MAT_SCHEMA_VERSION}:heartbeat`);
    expect(matKeys.blob("solana-tx", "chain=eth", "abc")).toBe(
      `ocb:mat:v${MAT_SCHEMA_VERSION}:solana-tx:chain=eth:abc`,
    );
    expect(matKeys.pointer("solana-tx", "chain=eth")).toBe(
      `ocb:mat:v${MAT_SCHEMA_VERSION}:solana-tx:chain=eth:current`,
    );
  });

  test("normalizes empty sig to 'all' so unfiltered + filtered variants never collide", () => {
    expect(matKeys.blob("x", "", "h")).toBe(
      `ocb:mat:v${MAT_SCHEMA_VERSION}:x:all:h`,
    );
    expect(matKeys.pointer("x", "")).toBe(
      `ocb:mat:v${MAT_SCHEMA_VERSION}:x:all:current`,
    );
  });
});
