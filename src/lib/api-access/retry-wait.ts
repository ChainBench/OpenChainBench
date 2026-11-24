const DEFAULT_RETRY_SECONDS = 60;

export function waitSeconds(body: unknown): number {
  const seconds =
    typeof body === "object" && body !== null && "retryAfterSec" in body
      ? body.retryAfterSec
      : null;
  return typeof seconds === "number" && seconds > 0
    ? seconds
    : DEFAULT_RETRY_SECONDS;
}

export function minutesToWait(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

export function minutesText(minutes: number): string {
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
