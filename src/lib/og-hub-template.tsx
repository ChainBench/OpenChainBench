import { ImageResponse } from "next/og";

/**
 * Shared OG template for hub pages (/about, /methodology, /contribute,
 * /press, /mcp, /benchmarks, /products, /alternatives/[slug]).
 *
 * The bench- and product-level OG handlers each have their own template
 * because they pull in live numbers and a category accent color. Hubs are
 * purely editorial, so a single template with a label, headline, subtitle
 * and accent stripe is enough to keep social previews on-brand without
 * duplicating ~80 lines per route file.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

type HubOgArgs = {
  /** Small uppercase tag above the headline (e.g. "About", "Methodology"). */
  kicker: string;
  /** Big serif headline, ~5-8 words. */
  headline: string;
  /** Italic supporting sentence, ~10-20 words. */
  subline: string;
  /** Optional accent color for the kicker. defaults to the site's brand red. */
  accent?: string;
};

export function renderHubOG({
  kicker,
  headline,
  subline,
  accent = "#7a2e1f",
}: HubOgArgs) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f8f3eb",
          color: "#1c1a17",
          padding: 60,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "Georgia, serif",
          backgroundImage:
            "radial-gradient(rgba(28,26,23,0.06) 1px, transparent 1px)",
          backgroundSize: "6px 6px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#7a7166",
          }}
        >
          <span>OpenChainBench</span>
          <span style={{ color: accent }}>{kicker}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 92,
              fontWeight: 700,
              lineHeight: 1.0,
              letterSpacing: -2,
              maxWidth: 1080,
            }}
          >
            {headline}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              fontStyle: "italic",
              color: "#4a443c",
              marginTop: 24,
              maxWidth: 1080,
              lineHeight: 1.25,
            }}
          >
            {subline}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "2px solid #1c1a17",
            paddingTop: 20,
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#1c1a17",
          }}
        >
          <span>openchainbench.com</span>
          <span>Open · Reproducible · Community-run</span>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
