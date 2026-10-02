import type { ProviderClaim } from "@/data/provider-registry";

/**
 * Statements a provider makes about itself, which no harness can measure.
 *
 * Aurora asked us to cover things this site has no instrument for: whether a
 * swap is insured, whether it is confidential, whether users are shielded
 * from questionable liquidity. Those are real properties and they matter to a
 * reader, but they are not measurements and must never be printed as if they
 * were. This site exists because marketing pages quote "real-time" without a
 * number; publishing a vendor's claim unqualified would make us the thing we
 * were built against.
 *
 * So a claim carries three things a measurement does not need: where we read
 * it, when we last looked, and the fact that it is the provider speaking. The
 * page renders all three, and a claim nobody has re-checked in a long time
 * says so rather than ageing silently into something that reads current.
 *
 * What a claim is NOT: a benchmark value, a ranking input, or anything that
 * can move a leader. Nothing here touches the ledger.
 */

/** A claim goes stale at six months. Long enough that re-checking is not
 *  busywork, short enough that a pricing page or a terms change is unlikely to
 *  have passed unnoticed for two of them. */
export const CLAIM_STALE_AFTER_DAYS = 183;

export type ClaimView = ProviderClaim & {
  /** Whole days since it was last verified; null when the date will not parse. */
  ageDays: number | null;
  /** Past CLAIM_STALE_AFTER_DAYS, so the page says so instead of ageing quietly. */
  stale: boolean;
};

/** Days between an ISO date and now, or null when the date is unusable. */
export function claimAgeDays(verifiedAt: string, now = new Date()): number | null {
  const d = new Date(`${verifiedAt}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return null; // a future date is a typo, not a fresh check
  return Math.floor(ms / 86_400_000);
}

/** Claims in the order a reader should meet them: anything stale last, so the
 *  section opens on what we actually stand behind. */
export function viewClaims(claims: ProviderClaim[] | undefined, now = new Date()): ClaimView[] {
  if (!claims || claims.length === 0) return [];
  return claims
    .map((c) => {
      const ageDays = claimAgeDays(c.verifiedAt, now);
      return { ...c, ageDays, stale: ageDays == null || ageDays > CLAIM_STALE_AFTER_DAYS };
    })
    .sort((a, b) => Number(a.stale) - Number(b.stale) || a.label.localeCompare(b.label));
}

/** "checked 12 days ago", for the line under each claim. A claim whose date
 *  will not parse says that plainly rather than printing a wrong age. */
export function claimAgeLabel(c: ClaimView): string {
  if (c.ageDays == null) return "verification date unreadable";
  if (c.ageDays === 0) return "checked today";
  if (c.ageDays === 1) return "checked yesterday";
  if (c.ageDays < 60) return `checked ${c.ageDays} days ago`;
  const months = Math.round(c.ageDays / 30.4);
  return `checked ${months} months ago`;
}

/** Problems that should stop a claim reaching a page. Returned rather than
 *  thrown so a test can assert the whole registry at once. */
export function claimProblems(slug: string, c: ProviderClaim): string[] {
  const out: string[] = [];
  const where = `${slug} claim "${c.label}"`;
  if (!c.label.trim()) out.push(`${where}: empty label`);
  if (!c.value.trim()) out.push(`${where}: empty value`);
  if (!/^https:\/\//.test(c.source)) {
    // An unsourced claim is a rumour, and http is not a source we can stand on.
    out.push(`${where}: source must be an https URL, got ${c.source || "(none)"}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.verifiedAt)) {
    out.push(`${where}: verifiedAt must be YYYY-MM-DD, got ${c.verifiedAt || "(none)"}`);
  } else if (claimAgeDays(c.verifiedAt) == null) {
    out.push(`${where}: verifiedAt is in the future or unparseable (${c.verifiedAt})`);
  }
  if (/\b(fastest|best|cheapest|leading|#1|number one)\b/i.test(c.value)) {
    // A superlative in a claim is marketing we would be laundering. The
    // measured columns are where a provider gets to be fastest.
    out.push(`${where}: value carries a superlative; quote the substance, not the boast`);
  }
  return out;
}
