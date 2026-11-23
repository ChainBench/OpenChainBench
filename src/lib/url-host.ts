export function bareHost(host: string): string {
  return host.replace(/^www\./, "").replace(/\.+$/, "");
}

export function isSameOrSubdomain(hostname: string, site: string): boolean {
  const host = bareHost(hostname);
  const bareSite = bareHost(site);
  return host === bareSite || host.endsWith(`.${bareSite}`);
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
