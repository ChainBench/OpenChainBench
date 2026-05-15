/**
 * Shared validators for URL-path segments that come from request input.
 * Hoisted so the same constraint is enforced everywhere a slug or provider
 * id reaches a loader, query, or cache key.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CHAIN_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
