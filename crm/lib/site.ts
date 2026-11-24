const DEFAULT_HOST = "openchainbench.com";
export const SITE_HOST = process.env.SITE_HOST ?? DEFAULT_HOST;
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const ACCESS_HOST_ENV = "API_ACCESS_SITE_HOST";
export const ACCESS_SITE_HOST =
  process.env[ACCESS_HOST_ENV]?.trim() || DEFAULT_HOST;
export const ACCESS_SITE_ORIGIN = `https://${ACCESS_SITE_HOST}`;
