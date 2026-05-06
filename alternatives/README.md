# Alternative landing pages

Each YAML in this folder produces a `/alternatives/<slug>` page that re-frames an existing benchmark as "X alternatives". built so anyone in the community can answer "what's an alternative to X?" by linking a permanent OpenChainBench URL instead of typing a list every time.

The benchmark stays the source of truth; the alternative file only carries the framing copy + a pointer to its source bench.

## Format

```yaml
slug: pump-portal                       # required, lowercase-hyphenated, becomes the URL
target_product: Pump Portal             # required, display name of the product the page is alternative-to
target_url: https://pumpportal.fun      # optional, rendered as a link
description: One-line description       # required
benchmark: aggregator-head-lag          # required, slug of an existing benchmark
chain: solana                           # optional, applied as chain filter on the source bench
intro: |                                # required, ≥40 chars. lead paragraph rendered above the data
  Looking for an alternative to Pump Portal? Here's how the major
  onchain data providers compare on real-time blockchain data latency...
seo_title: Pump Portal alternatives. live latency benchmark
seo_description: Compare Mobula, GeckoTerminal and Codex on...
status: live                            # optional, default live
```

## How a request gets answered

1. Someone in a Discord/Telegram asks "what's an alternative to Foo?"
2. You drop `https://openchainbench.com/alternatives/foo`
3. The page shows the same live numbers as the benchmark it points at, framed as "Foo alternatives" with the right intro paragraph and SEO metadata so it ranks for the search query.

## Adding a new alternative

1. Drop a YAML in this folder. Pick a benchmark whose providers are credible competitors of the target product.
2. Open a PR. CI doesn't validate alternatives explicitly today, but the runtime loader logs warnings for malformed entries and skips them. so check the deploy logs after merge.
3. The page is auto-added to `/sitemap.xml` for indexing.

## Currently shipped

| Slug | Target product | Source bench |
| --- | --- | --- |
| `pump-portal` | Pump Portal | aggregator-head-lag |
| `bitquery` | Bitquery | network-coverage |
| `birdeye` | Birdeye | metadata-coverage (Solana only) |
| `relay` | Relay | bridge-quote-latency |

## License

MIT. same as the rest of OpenChainBench.
