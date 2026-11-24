import { afterEach, beforeEach } from "bun:test";

export function isolateEnv(names: readonly string[]): void {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  beforeEach(() => {
    for (const name of names) delete process.env[name];
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
