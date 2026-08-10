import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchAppsLeaderboard, type ProtocolRow } from "@/lib/apps-leaderboard";
import { AppsLeaderboardTable } from "@/components/apps-leaderboard-table";

const DESCRIPTION =
  "Protocol revenue leaderboard for on-chain apps: fees captured by treasury, token holders, and LPs. Reproducible methodology, refreshed daily, sources public.";

export const metadata: Metadata = pageMetadata({
  path: "/apps",
  title: "Protocol Revenue Leaderboard 2026 — OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 300;

export default async function AppsHubPage() {
  const data = await fetchAppsLeaderboard();

  const breadcrumb = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Apps", item: `${SITE.url}/apps` },
    ]),
  };

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />

      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Protocol revenue.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        {DESCRIPTION}
      </p>

      <div className="mt-10">
        <AppsLeaderboardTable protocols={data?.protocols ?? []} updatedAt={data?.updatedAt ?? null} />
      </div>

      <p className="mt-8 text-xs text-ink-muted leading-relaxed max-w-2xl">
        <strong>Gross fees</strong> = all fees collected by the protocol before any distribution.{" "}
        <strong>Net value captured</strong> = burn + treasury + token holder − emissions.
        Builder/interface fees (paid to frontend operators) are excluded.
        Methodology versions and allocation params are on-chain verifiable.
      </p>
    </article>
  );
}
