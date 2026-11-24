export function causeCode(err: Error): string | null {
  const { cause } = err;
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : null;
}
