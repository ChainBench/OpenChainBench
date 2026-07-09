import type { Metadata } from "next";
import Image from "next/image";
import { SectionRule } from "@/components/section-rule";
import { pressPageLd } from "@/lib/hub-jsonld";
import { safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/press",
  title: "Press kit",
  description: "Press kit for journalists and partners: logos, boilerplate, quick facts and contact details. All OpenChainBench data is citable under CC BY 4.0.",
});

export default function PressPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      {pressPageLd().map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Press kit</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          For journalists, podcasters and analysts covering crypto-infra performance.
        </p>
      </header>

      <SectionRule label="Boilerplate" number="i" />
      <blockquote className="border-l-4 border-ink pl-6 py-2 text-base leading-relaxed text-ink-soft">
        OpenChainBench is an open, reproducible benchmark series for crypto infrastructure. Each report measures latency, accuracy or reliability of one category. aggregators, bridges, RPCs, price feeds. and ships alongside the script that produced it. Methodology, specs and raw metrics are public. The project is community-run and MIT-licensed.
      </blockquote>

      <SectionRule label="Quick facts" number="ii" />
      <dl className="grid gap-3 sm:grid-cols-2 ">
        <Fact term="Founded" value="2026" />
        <Fact term="Categories" value="Aggregators · Blockchains · Bridges · Trading · Wallets · RPCs" />
        <Fact term="Source code" value="github.com/ChainBench/OpenChainBench" />
        <Fact term="License" value="MIT (code) · CC-BY-4.0 (reports)" />
      </dl>

      <SectionRule label="OCBKit" number="iii" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-md text-base leading-relaxed text-ink-soft">
          Logos and X-ready banners. Free to use in editorial and partner contexts with attribution.
        </p>
        <a
          href="/press/OCBKit.zip"
          download
          className="self-start label-mono inline-flex items-center gap-1.5 border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper transition-colors sm:self-auto"
        >
          Download OCBKit (.zip)
        </a>
      </div>

      {/* Tile background = the surface the logo is designed to sit on.
          Dark-colored logo → light background (so it's visible).
          White logo → dark background. Grey logo → mid-tone. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <KitTile name="Dark logo" file="dark-logo.png" tone="light" />
        <KitTile name="Grey logo" file="grey-logo.png" tone="grey" />
        <KitTile name="White logo" file="white-logo.png" tone="dark" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <KitTile name="X banner · 1" file="banner-1.png" tone="dark" wide />
        <KitTile name="X banner · 2" file="banner-2.png" tone="dark" wide />
      </div>

      <SectionRule label="Use of figures" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        All charts and tables on this site are free to reproduce in editorial contexts with attribution to OpenChainBench and a link to the source report. Please don&apos;t crop charts in a way that changes their meaning.
      </p>

      <SectionRule label="Contact" number="v" />
      <p className="text-base leading-relaxed text-ink-soft">
        For interviews, custom benchmark requests or pre-publication embargoes. open an issue or a discussion on{" "}
        <a className="lnk" href="https://github.com/ChainBench/OpenChainBench">GitHub</a>.
      </p>
    </article>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="border-y border-rule py-3">
      <dt className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-muted">{term}</dt>
      <dd className="mt-1 text-base font-medium break-all">{value}</dd>
    </div>
  );
}

function KitTile({
  name,
  file,
  tone,
  wide,
}: {
  name: string;
  file: string;
  tone: "dark" | "grey" | "light";
  wide?: boolean;
}) {
  const bg =
    tone === "dark"
      ? "bg-ink"
      : tone === "grey"
        ? "bg-[var(--color-paper-soft)]"
        : "bg-paper border border-rule";
  return (
    <figure className="flex flex-col gap-2">
      <div className={`${bg} flex items-center justify-center ${wide ? "aspect-[3/1]" : "aspect-[3/2]"} overflow-hidden`}>
        <Image
          src={`/press/ocbkit/${file}`}
          alt={name}
          width={wide ? 1500 : 600}
          height={wide ? 500 : 400}
          className="max-w-[80%] max-h-[80%] object-contain"
        />
      </div>
      <figcaption className="flex items-baseline justify-between">
        <span className="label-mono text-ink-muted">{name}</span>
        <a
          href={`/press/ocbkit/${file}`}
          download
          className="label-mono text-ink-faint hover:text-ink transition-colors"
        >
          .png
        </a>
      </figcaption>
    </figure>
  );
}
