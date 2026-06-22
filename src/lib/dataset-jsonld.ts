/**
 * schema.org/Dataset JSON-LD builders.
 *
 * Two consumers:
 *  - The home page emits the site-wide Dataset entry (`GLOBAL_DATASET_JSONLD`)
 *    so Google Dataset Search, Perplexity and other crawlers discover the
 *    canonical OpenChainBench corpus + the public Hugging Face mirror.
 *  - Each /benchmarks/<slug> page emits a per-bench Dataset via
 *    `buildBenchDatasetJsonLd` so the same crawlers index every bench as
 *    its own dataset entry, linking back to the JSON stat endpoint.
 *
 * Both shapes satisfy Google's required Dataset fields (`name`,
 * `description`) and the strongly recommended ones (`url`, `license`,
 * `creator`, `distribution`, `isAccessibleForFree`, `sameAs`,
 * `temporalCoverage`, `keywords`).
 *
 * Required Dataset fields per
 * https://developers.google.com/search/docs/appearance/structured-data/dataset
 */
import { SITE } from "@/data/site";

/** Public Hugging Face dataset mirror. CC-BY-4.0, daily parquet snapshots. */
export const HF_DATASET_URL =
  "https://huggingface.co/datasets/OpenChainBench/benchmarks";

/** Concept DOI for the dataset on Zenodo. Always resolves to the latest
 *  version. New version DOIs are minted automatically when we push a
 *  new git tag of the form `vX.Y.Z-dataset`. */
export const ZENODO_CONCEPT_DOI = "10.5281/zenodo.20800311";
export const ZENODO_CONCEPT_URL = `https://doi.org/${ZENODO_CONCEPT_DOI}`;

/** Latest parquet headlines snapshot. `LATEST` is the convention used by
 *  the HF publisher pipeline so downstream consumers can pin to a date or
 *  follow head. */
export const HF_HEADLINES_LATEST =
  "https://huggingface.co/datasets/OpenChainBench/benchmarks/resolve/main/headlines/snapshot_date=LATEST/part-0.parquet";

/** CC-BY-4.0 license URL. Matches the per-row license surfaced in
 *  /api/citable and the footer on every page. */
export const DATASET_LICENSE = "https://creativecommons.org/licenses/by/4.0/";

/** Day the HF dataset went live (matches the first published snapshot).
 *  Used as the lower bound of `temporalCoverage`. The `..` upper bound
 *  marks the dataset as ongoing per schema.org ISO 8601 time interval
 *  notation. */
const TEMPORAL_COVERAGE_START = "2026-06-22";

const KEYWORDS = [
  "crypto",
  "blockchain",
  "benchmarks",
  "RPC",
  "oracles",
  "bridges",
  "latency",
  "open data",
  "infrastructure",
];

const CREATOR_PUBLISHER = {
  "@type": "Organization",
  "@id": `${SITE.url}/#org`,
  name: SITE.name,
  url: SITE.url,
} as const;

/**
 * Site-wide Dataset entry. Emitted on the home page so Google Dataset
 * Search and Perplexity have a single canonical record pointing at both
 * the live JSON index (/api/citable) and the parquet mirror on HF.
 */
export const GLOBAL_DATASET_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": `${SITE.url}/#dataset`,
  name: "OpenChainBench Benchmarks",
  description:
    "Daily open benchmarks of crypto infrastructure: RPC latency, bridge fees, L2 finality, price feed accuracy, oracle deviation and more. Continuously measured by reproducible harnesses, surfaced as JSON via /api/citable and mirrored to Hugging Face as daily parquet snapshots.",
  url: SITE.url,
  identifier: [SITE.url, ZENODO_CONCEPT_DOI, ZENODO_CONCEPT_URL],
  sameAs: [HF_DATASET_URL, SITE.github, ZENODO_CONCEPT_URL],
  license: DATASET_LICENSE,
  creator: CREATOR_PUBLISHER,
  publisher: CREATOR_PUBLISHER,
  keywords: KEYWORDS,
  isAccessibleForFree: true,
  temporalCoverage: `${TEMPORAL_COVERAGE_START}/..`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/parquet",
      contentUrl: HF_HEADLINES_LATEST,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${SITE.url}/api/citable`,
    },
  ],
} as const;

/** Inputs for a per-bench Dataset entry. Keeps the call site at
 *  /benchmarks/[slug] decoupled from the Benchmark type so the helper is
 *  trivially reusable from the per-chain page and future variants. */
export type BenchDatasetInput = {
  slug: string;
  name: string;
  alternateName?: string;
  description: string;
  url: string;
  /** Schema.org Dataset accepts variableMeasured as a string or array.
   *  We pass an array of metric labels (p50, p90, p99, sample_size, ...)
   *  so Google's validator reports each metric individually. */
  variableMeasured: string[];
  category: string;
  datePublished: string;
  dateModified?: string;
  measurementTechnique?: string;
};

/**
 * Build a per-bench Dataset JSON-LD object. Returns the bare node so the
 * call site can wrap it in an `@graph` alongside other types
 * (TechArticle, BreadcrumbList) without duplicating the @context.
 */
export function buildBenchDatasetJsonLd(
  input: BenchDatasetInput,
): Record<string, unknown> {
  const statApi = `${SITE.url}/api/stat/${input.slug}`;
  return {
    "@type": "Dataset",
    "@id": `${input.url}#dataset`,
    name: input.name,
    ...(input.alternateName ? { alternateName: input.alternateName } : {}),
    description: input.description,
    url: input.url,
    identifier: input.slug,
    sameAs: [statApi, HF_DATASET_URL, ZENODO_CONCEPT_URL],
    keywords: [
      input.category,
      ...KEYWORDS,
      ...input.variableMeasured,
    ],
    creator: CREATOR_PUBLISHER,
    publisher: CREATOR_PUBLISHER,
    isAccessibleForFree: true,
    license: DATASET_LICENSE,
    datePublished: input.datePublished,
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    variableMeasured: input.variableMeasured,
    isPartOf: { "@id": `${SITE.url}/#dataset` },
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: statApi,
      },
      {
        "@type": "DataDownload",
        encodingFormat: "application/parquet",
        contentUrl: HF_HEADLINES_LATEST,
      },
    ],
    ...(input.measurementTechnique
      ? { measurementTechnique: input.measurementTechnique }
      : {}),
  };
}
