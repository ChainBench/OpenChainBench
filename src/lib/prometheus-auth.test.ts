import { afterEach, describe, expect, it } from "bun:test";
import { promAuthHeaders } from "./prometheus";

const KEY = "PROMETHEUS_BASIC_AUTH";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("promAuthHeaders", () => {
  it("sends nothing when no credential is configured", () => {
    delete process.env[KEY];
    expect(promAuthHeaders(new URL("https://prom.openchainbench.com/api/v1/query"))).toEqual({});
  });

  // The order of rollout depends on this: the code ships first and stays inert,
  // the variable is set second, and only then does Caddy start demanding auth.
  // If an unset variable produced a header, step one would already 401.
  it("stays inert so it can ship before the edge demands auth", () => {
    process.env[KEY] = "";
    expect(promAuthHeaders(new URL("https://prom.openchainbench.com/api/v1/query"))).toEqual({});
  });

  it("encodes user:password as a basic credential", () => {
    process.env[KEY] = "florent:s3cret";
    const h = promAuthHeaders(new URL("https://prom.openchainbench.com/api/v1/query"));
    expect(h.authorization).toBe(`Basic ${Buffer.from("florent:s3cret").toString("base64")}`);
    // Decodes back to exactly what Caddy's basic_auth compares against.
    const decoded = Buffer.from(h.authorization.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("florent:s3cret");
  });

  it("trims surrounding whitespace, which a copied env value carries", () => {
    process.env[KEY] = "  florent:s3cret\n";
    const h = promAuthHeaders(new URL("https://prom.openchainbench.com/api/v1/query"));
    const decoded = Buffer.from(h.authorization.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("florent:s3cret");
  });

  // A value with no colon is a misconfiguration. Sending it would answer 401
  // on every bench with nothing to point at; refusing to send it leaves the
  // benches working and the missing auth visible.
  it("refuses a value that cannot be user:password", () => {
    process.env[KEY] = "justatoken";
    expect(promAuthHeaders(new URL("https://prom.openchainbench.com/api/v1/query"))).toEqual({});
  });

  // The worker reaches Prometheus in-network over plain http at ocb-prom:9090,
  // which needs no credential. Forwarding one would put it somewhere it never
  // has to be.
  it("never sends the credential over plain http", () => {
    process.env[KEY] = "florent:s3cret";
    expect(promAuthHeaders(new URL("http://ocb-prom:9090/api/v1/query"))).toEqual({});
    expect(promAuthHeaders(new URL("http://localhost:9090/api/v1/query"))).toEqual({});
  });

  it("keeps a password containing colons intact", () => {
    process.env[KEY] = "florent:pa:ss:word";
    const h = promAuthHeaders(new URL("https://prom.openchainbench.com/api/v1/query"));
    const decoded = Buffer.from(h.authorization.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("florent:pa:ss:word");
  });
});
