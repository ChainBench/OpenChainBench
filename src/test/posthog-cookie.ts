export function posthogCookie(name: string, value: unknown): string {
  return `${name}=${encodeURIComponent(JSON.stringify(value))}`;
}
