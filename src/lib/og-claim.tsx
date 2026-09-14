import type { Benchmark } from "@/types/benchmark";
import { headlineParts } from "@/lib/citation";

/** Marker colour behind the leader claim on the social cards. Warm
 *  orange on the cream card ground: readable at thumbnail size, and not
 *  a category colour, so it means "the number" on every bench alike. */
export const OG_CLAIM_MARKER = "#ffb257";

/**
 * The headline sentence for OG / Twitter cards, with the leader claim
 * ("GNS posts the lowest p/f ratio at 1.559x") run through a highlighter
 * and the qualifier ("(p50, 24h) on <title>.") underneath in the muted
 * italic the cards already use. Satori lays each child span out as a
 * flex item, so the claim sits on its own line and wraps within itself
 * when it is long. Falls back to the subtitle when there is no leader.
 */
export function OgClaimSentence({
  benchmark,
  fallback,
}: {
  benchmark: Benchmark;
  fallback: string;
}) {
  const { claim, rest } = headlineParts(benchmark);
  // The title is already the card's headline; keep only the window
  // qualifier ("(p50, 24h)") under the claim instead of repeating it.
  const qualifier = rest.replace(` on ${benchmark.title}.`, "");
  if (!claim) {
    return (
      <div
        style={{
          display: "flex",
          fontSize: 28,
          fontStyle: "italic",
          color: "#4a443c",
          marginTop: 18,
          maxWidth: 1080,
        }}
      >
        {fallback}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        marginTop: 18,
        maxWidth: 1080,
      }}
    >
      <span
        style={{
          fontSize: 30,
          fontWeight: 700,
          color: "#1c1a17",
          backgroundColor: OG_CLAIM_MARKER,
          padding: "4px 12px",
          borderRadius: 6,
        }}
      >
        {claim}
      </span>
      <span
        style={{
          fontSize: 26,
          fontStyle: "italic",
          color: "#4a443c",
          marginTop: 10,
        }}
      >
        {qualifier}
      </span>
    </div>
  );
}

/**
 * Generic form for cards whose body is free text (report hero finding,
 * product line): `lead` goes through the highlighter, `rest` follows in
 * the muted italic. Same marker, same sizes as the bench claim.
 */
export function OgHighlight({ lead, rest }: { lead: string; rest?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        marginTop: 18,
        maxWidth: 1080,
      }}
    >
      <span
        style={{
          fontSize: 30,
          fontWeight: 700,
          color: "#1c1a17",
          backgroundColor: OG_CLAIM_MARKER,
          padding: "4px 12px",
          borderRadius: 6,
        }}
      >
        {lead}
      </span>
      {rest ? (
        <span
          style={{
            fontSize: 26,
            fontStyle: "italic",
            color: "#4a443c",
            marginTop: 10,
            lineHeight: 1.4,
          }}
        >
          {rest}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Split a finding into a short lead clause and the remainder: cut at the
 * first ", " / ". " / "; " / " — " boundary at or after `min` chars, and
 * never past `max`. Text with no usable boundary is all lead when short,
 * else cut at the last space before `max`.
 */
export function splitLead(
  text: string,
  { min = 24, max = 84 }: { min?: number; max?: number } = {},
): { lead: string; rest: string } {
  const t = text.trim();
  const re = /,\s|\.\s|;\s|\s[—–-]\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index > max) break;
    if (m.index >= min) {
      return {
        lead: t.slice(0, m.index).trim(),
        rest: t.slice(m.index + m[0].length).trim(),
      };
    }
  }
  if (t.length <= max) return { lead: t, rest: "" };
  const cut = t.lastIndexOf(" ", max);
  return cut > min
    ? { lead: t.slice(0, cut).trim(), rest: t.slice(cut).trim() }
    : { lead: t.slice(0, max).trim(), rest: t.slice(max).trim() };
}
