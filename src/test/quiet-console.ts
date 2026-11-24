import { type Mock, afterEach, beforeEach, spyOn } from "bun:test";

type Muted = {
  errors: () => Mock<typeof console.error>;
  warnings: () => Mock<typeof console.warn>;
};

export function quietConsole(): Muted {
  let errors: Mock<typeof console.error> | undefined;
  let warnings: Mock<typeof console.warn> | undefined;
  beforeEach(() => {
    errors = spyOn(console, "error").mockImplementation(() => {});
    warnings = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    errors?.mockRestore();
    warnings?.mockRestore();
  });
  const muted = <T>(mock: T | undefined): T => {
    if (!mock) throw new Error("console is muted only inside a test");
    return mock;
  };
  return { errors: () => muted(errors), warnings: () => muted(warnings) };
}
