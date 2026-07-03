#!/usr/bin/env python3
"""One-shot generator for the per-chain RPC benchmark cluster (044-053).

Reads provider metadata from benchmarks/rpc-capabilities.yml (the parent,
which stays live as the cross-chain index) and emits one first-class
bench YAML per chain with:
  - chain baked into every PromQL selector
  - region as the only dimension (us-east / eu-west / sgp)
  - chain-specific editorial (seo_intro, findings, faq) so the cluster
    never reads as 10 copies of one template

Run once, review the diff, delete or keep for future regeneration.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARENT = ROOT / "benchmarks" / "rpc-capabilities.yml"

# Live provider x chain matrix (verified against Prom 2026-07-03).
CHAINS = {
    "ethereum":  {"num": "044", "label": "Ethereum",  "providers": ["publicnode", "drpc", "1rpc", "tenderly", "nodies", "lava", "meowrpc", "flashbots", "cloudflare"]},
    "arbitrum":  {"num": "045", "label": "Arbitrum",  "providers": ["publicnode", "drpc", "1rpc", "tenderly", "nodies", "lava", "meowrpc", "arbitrum-official"]},
    "base":      {"num": "046", "label": "Base",      "providers": ["publicnode", "drpc", "tenderly", "nodies", "merkle", "base-official"]},
    "optimism":  {"num": "047", "label": "Optimism",  "providers": ["publicnode", "drpc", "1rpc", "tenderly", "nodies", "optimism-official"]},
    "avalanche": {"num": "048", "label": "Avalanche", "providers": ["publicnode", "drpc", "1rpc", "tenderly", "nodies", "avalanche-official"]},
    "bnb":       {"num": "049", "label": "BNB Chain", "providers": ["publicnode", "drpc", "nodies", "merkle", "binance"]},
    "polygon":   {"num": "050", "label": "Polygon",   "providers": ["publicnode", "drpc", "1rpc", "tenderly", "nodies"]},
    "linea":     {"num": "051", "label": "Linea",     "providers": ["publicnode", "drpc", "1rpc", "tenderly"]},
    "scroll":    {"num": "052", "label": "Scroll",    "providers": ["publicnode", "drpc", "1rpc", "tenderly"]},
    "mantle":    {"num": "053", "label": "Mantle",    "providers": ["publicnode", "drpc", "1rpc", "tenderly"]},
}

# Chain-specific editorial. Every string is unique to its chain so the
# cluster never reads as one duplicated template.
EDITORIAL = {
    "ethereum": {
        "intro": "Ethereum carries the largest free-RPC cohort we measure: 9 no-key providers answering the same `eth_blockNumber` probe every 15 seconds from three regions. It is also the chain where reliability analysis earns its keep. Cloudflare-eth answers HTTP 200 in well under a second while an increasing share of calls resolve to a JSON-RPC error body (`-32046 Cannot fulfill request`), and Merkle is excluded outright after recurring Cloudflare lockouts that froze our probes for 20 minutes after a single request. If you paste a free RPC URL into an Ethereum dapp, this page is the live answer to which one deserves it.",
        "findings": [
            "{{best_name}} currently leads the free Ethereum RPC field at {{best_p50}} (`eth_blockNumber` p50, 24h) across 9 measured providers, the largest cohort of any chain in the cluster.",
            "Cloudflare-eth is the resident cautionary tale: sub-second HTTP 200s that increasingly carry a JSON-RPC error instead of a block number. The success-rate column, not the latency column, tells the real story.",
            "The p50-to-p99 spread separates the tiers. {{name:1rpc}} sits at {{p50:1rpc}} median but its p99 regularly runs an order of magnitude higher, while {{name:drpc}} ({{p50:drpc}}) keeps a much tighter distribution.",
            "Merkle is excluded on Ethereum by design: its endpoint sits behind an aggressive bot filter that locks out programmatic clients for ~20 minutes after one request, invisible on any status page.",
        ],
        "faq_extra_q": "Why is Cloudflare's Ethereum RPC marked unreliable here?",
        "faq_extra_a": "Cloudflare's public Ethereum gateway switched to a permissioned mode for many JSON-RPC methods. The endpoint still responds fast with HTTP 200, but the body is increasingly a JSON-RPC error (`-32046`) rather than a usable result. We classify a call as `ok` only when the HTTP status is 200 AND the body carries a usable `result` field, so Cloudflare's real success rate is visible in the reliability column instead of hiding behind fast error responses.",
    },
    "arbitrum": {
        "intro": "Arbitrum is the second-largest cohort in the cluster: 8 no-key providers including the Arbitrum Foundation's own `arb1.arbitrum.io/rpc`, and one of the few chains where Lava and MeowRPC still compete on a free tier. Foundation endpoints are documented best-effort, and our data shows what that means in practice: a respectable median with a p99 roughly ten times worse. Every provider answers the identical `eth_blockNumber` probe every 15 seconds from us-east, eu-west and Singapore.",
        "findings": [
            "{{best_name}} currently leads free Arbitrum RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 8 measured providers.",
            "The Arbitrum Foundation endpoint is the textbook best-effort profile: usable median, heavy tail. Its p99 routinely runs ~10x its p50, which matters if your product retries on timeout.",
            "Arbitrum is one of only two chains (with Ethereum) where {{name:lava}} and {{name:meowrpc}} qualify no-key, both providers key-gate or skip most other chains.",
            "{{name:drpc}} at {{p50:drpc}} and {{name:publicnode}} at {{p50:publicnode}} anchor the multi-chain gateway tier; regional splits between them flip depending on probe origin.",
        ],
        "faq_extra_q": "Should I use the official Arbitrum Foundation RPC in production?",
        "faq_extra_a": "The Foundation documents `arb1.arbitrum.io/rpc` as best-effort and rate-limited, intended for development. Our continuous measurement confirms the profile: acceptable p50 with a p99 tail several times worse than the leading gateways. For read-heavy production paths a gateway with a tighter distribution is the safer default; keep the official endpoint as a fallback rather than a primary.",
    },
    "base": {
        "intro": "Base offers the cleanest official-versus-gateway comparison in the cluster: Coinbase operates both the sequencer and the chain-official `mainnet.base.org`, so the house endpoint has every locational advantage, and it still has to beat PublicNode, dRPC, Tenderly, Nodies and Merkle on a level probe. 6 providers, the same `eth_blockNumber` call every 15 seconds, three regions, stale-head detection against the cross-provider tip.",
        "findings": [
            "{{best_name}} currently leads free Base RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 6 measured providers.",
            "Base is one of only two chains where {{name:merkle}} qualifies no-key (with BNB); its distribution is among the tightest in the whole cluster, p99 barely above p50.",
            "The official `mainnet.base.org` and the multi-chain gateways trade the lead depending on region, a reminder that \"fastest\" is a per-origin question, not a global one.",
        ],
        "faq_extra_q": "Is Coinbase's official Base RPC faster than third-party gateways?",
        "faq_extra_a": "Not consistently. Despite being operated by the same team that runs the sequencer, `mainnet.base.org` trades the lead with PublicNode, dRPC and Tenderly depending on which region the request originates from. Check the region tabs on this page for the origin closest to your deployment; the cross-region average hides these flips.",
    },
    "optimism": {
        "intro": "Optimism pits the Foundation's `mainnet.optimism.io` against 5 multi-chain no-key gateways. As on Arbitrum, the official endpoint is documented best-effort, and the measured tail confirms it, while the gateway tier (PublicNode, dRPC, Tenderly, 1RPC, Nodies) competes on tighter distributions. Probes run every 15 seconds from three regions with full response classification, so an endpoint stuck on an old head is flagged `stale` rather than ranked fast.",
        "findings": [
            "{{best_name}} currently leads free Optimism RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 6 measured providers.",
            "The Optimism Foundation endpoint shows the same best-effort signature as its Arbitrum counterpart: fine median, p99 several multiples worse, exactly what \"documented best-effort\" looks like in continuous measurement.",
            "OP Stack symmetry check: comparing this page with the Base leaderboard shows how two chains sharing a stack diverge purely on operator infrastructure.",
        ],
        "faq_extra_q": "Do Base and Optimism RPCs perform the same since both are OP Stack?",
        "faq_extra_a": "No. The stack is shared but the infrastructure is not: different operators, different peering, different gateway coverage. Our measurements regularly show different leaders and different tail behavior on the two chains. If you deploy on both, pick the RPC per chain from each page rather than assuming OP Stack parity.",
    },
    "avalanche": {
        "intro": "Avalanche's C-Chain field combines Ava Labs' official `api.avax.network` with 5 no-key multi-chain gateways. The official endpoint shows one of the tightest distributions among foundation RPCs, a contrast with the best-effort profiles on Arbitrum and Optimism. Every provider answers the identical probe every 15 seconds from us-east, eu-west and Singapore, with stale-head detection flagging anything more than 20 blocks behind the cross-provider tip.",
        "findings": [
            "{{best_name}} currently leads free Avalanche RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 6 measured providers.",
            "Unlike the Arbitrum and Optimism foundation endpoints, `api.avax.network` keeps a tight p50-to-p99 ratio, an official endpoint that behaves like managed infrastructure rather than a best-effort courtesy.",
            "{{name:publicnode}} ({{p50:publicnode}}) and {{name:drpc}} ({{p50:drpc}}) give the C-Chain the same reliable gateway floor they provide on every EVM chain we measure.",
        ],
        "faq_extra_q": "Is the official Avalanche RPC good enough for production reads?",
        "faq_extra_a": "Among chain-official endpoints it is one of the strongest we measure: tight latency distribution and a high success rate rather than the best-effort tail seen on some other foundation RPCs. The usual free-tier caveats still apply (shared rate limits, no SLA), but as a read path it holds up unusually well against the commercial gateways.",
    },
    "bnb": {
        "intro": "BNB Chain is the incumbent's chain: Binance's `bsc-dataseed1.binance.org` has been the copy-paste default since 2020, and from some regions it is still the single fastest RPC response we measure anywhere in the cluster. The catch is that it serves exactly one chain, while PublicNode, dRPC, Nodies and Merkle bring multi-chain coverage with increasingly competitive latency from EU origins. 5 providers, identical probes, three regions.",
        "findings": [
            "{{best_name}} currently leads free BNB Chain RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 5 measured providers.",
            "Binance's dataseed is a single-chain specialist: blisteringly fast near its home regions (single-digit milliseconds from us-east at times) and 10x slower from Singapore, the widest regional spread in the cluster.",
            "{{name:merkle}} qualifies here (BNB is one of its two stable no-key chains) and brings its signature tight distribution to a field otherwise dominated by the dataseed's regional extremes.",
        ],
        "faq_extra_q": "Is bsc-dataseed still the best RPC for BNB Chain?",
        "faq_extra_a": "It depends entirely on where your requests originate. From regions near Binance's infrastructure the dataseed is often the fastest single response in our whole dataset; from Singapore it can be 10x slower than the gateway tier. Check the region tabs above, the cross-region average is meaningless for an endpoint with this much geographic variance.",
    },
    "polygon": {
        "intro": "Polygon has no chain-official endpoint in the free tier, so this is the purest gateway-versus-gateway comparison in the cluster: PublicNode, dRPC, 1RPC, Tenderly and Nodies, all answering the same `eth_blockNumber` probe every 15 seconds from three regions. With no house endpoint to anchor expectations, the regional flips between gateways decide the ranking, and they flip often.",
        "findings": [
            "{{best_name}} currently leads free Polygon RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 5 measured providers.",
            "No foundation endpoint means no single-chain specialist skewing the field: every provider here also serves 4+ other chains, making Polygon the cleanest read on pure gateway quality.",
            "Regional leadership flips are the norm: the gateway that wins from us-east is regularly beaten from Singapore, so the region tabs above are not decoration, they are the actual answer.",
        ],
        "faq_extra_q": "Why is there no official Polygon RPC in this benchmark?",
        "faq_extra_a": "Polygon's historically documented public endpoint (`polygon-rpc.com`) is operated by a third party and has moved in and out of key-gating and rate-limit regimes that break our 15-second probe cadence. The bench includes only endpoints that sustain continuous no-key probing; the multi-chain gateways above all pass that bar on Polygon.",
    },
    "linea": {
        "intro": "The no-key field thins out on Linea: 4 providers qualify (PublicNode, dRPC, 1RPC, Tenderly), all multi-chain gateways. Thinner competition makes the reliability columns matter more than raw speed, a fast endpoint with a high stale or timeout rate is a worse default than a slightly slower consistent one. Probes run every 15 seconds from us-east, eu-west and Singapore with full response classification.",
        "findings": [
            "{{best_name}} currently leads free Linea RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "With only 4 qualifying providers, a single gateway having a bad day reshuffles the whole board; the success-rate column is the tiebreaker the median doesn't show.",
            "{{name:tenderly}} covers Linea in its 9-chain public gateway, one of the few non-major chains where its no-key tier reaches.",
        ],
        "faq_extra_q": "Why do so few free RPCs support Linea?",
        "faq_extra_a": "Free-tier coverage follows demand: gateways add no-key chains when traffic justifies the infrastructure. Linea's cohort (4 providers) is typical of newer L2s, compare with 9 on Ethereum and 8 on Arbitrum. The flip side is that the providers that do qualify are the disciplined multi-chain operators, so the reliability floor is high even where the field is thin.",
    },
    "scroll": {
        "intro": "Scroll runs the same 4-gateway field as Linea (PublicNode, dRPC, 1RPC, Tenderly), making the two chains a natural controlled experiment: same providers, same probe, different chain infrastructure. The differences you see between this page and the Linea leaderboard are the chains, not the gateways. Probes every 15 seconds, three regions, stale-head detection against the cross-provider tip.",
        "findings": [
            "{{best_name}} currently leads free Scroll RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "Scroll and Linea share an identical provider field, so cross-reading the two pages isolates chain-side latency from gateway-side latency, a comparison no single-chain benchmark can offer.",
            "As on every thin-cohort chain, the success-rate column outranks the latency column for picking a production default.",
        ],
        "faq_extra_q": "Which free RPC should I default to on Scroll?",
        "faq_extra_a": "Start from the current leader above, then check its per-region row for the origin closest to your deployment. With a 4-provider field the honest answer changes more often than on Ethereum, so a primary-plus-fallback pair (the top two on this page) is the resilient configuration rather than any single hardcoded URL.",
    },
    "mantle": {
        "intro": "Mantle rounds out the cluster's long tail with 4 qualifying no-key providers, all multi-chain gateways (PublicNode, dRPC, 1RPC, Tenderly). Like every chain in the family, the number that matters is a sustained median, the same `eth_blockNumber` call every 15 seconds from three regions over a rolling 24 hours, not a one-off marketing burst, and archive-depth support is audited separately every 5 minutes.",
        "findings": [
            "{{best_name}} currently leads free Mantle RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "Mantle's field mirrors Linea and Scroll: the disciplined multi-chain gateways and nobody else, so the leaderboard is a pure read on how each gateway's infrastructure reaches the chain.",
            "Thin cohorts amplify tail events, one regional incident at one gateway visibly moves the 24h aggregate, which is exactly why the page shows per-region breakdowns instead of only the average.",
        ],
        "faq_extra_q": "Are free Mantle RPCs reliable enough to build on?",
        "faq_extra_a": "The four qualifying gateways all maintain high measured success rates on Mantle, but a 4-provider field means less redundancy if one degrades. Use the current leader as primary and the runner-up as fallback, and re-check this page after incidents, the ranking is live and the honest answer moves.",
    },
}

SHARED_METHO = [
    'Cadence: every 15 seconds per provider, from each of 3 probe regions (us-east Virginia, eu-west Amsterdam, sgp Singapore). Headline p50/p90/p99 aggregate across all 3 regions via Prometheus `avg(quantile_over_time(...))`; per-region breakdowns are first-class on this page via the region tabs.',
    'Payload: `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`. Plain HTTP POST, identical for every endpoint, no API key in any request.',
    "Latency: client-side round-trip delta in milliseconds, exposed as both a gauge and a histogram (buckets 50 ms → 10 s), so percentiles are computed via Prometheus `quantile_over_time` over the last 24 hours.",
    "Call-result classification: `ok` (HTTP 200 + non-empty result), `http_err`, `jsonrpc_err` (HTTP 200 carrying an error body), `stale` (more than 20 blocks behind the cross-provider tip), `timeout`. Latency without reliability is a misleading ranking signal.",
    "Archive depth: every 5 minutes we issue `eth_getBalance` at (head − depth) for depths from Geth's default pruned cap up to 5M blocks, exposing which free endpoints actually serve historical state.",
    "This page is part of the per-chain RPC cluster derived from the cross-chain [rpc-capabilities](https://openchainbench.com/benchmarks/rpc-capabilities) benchmark; the identical harness, methodology and exclusion rules apply on every chain.",
]


def parse_parent_providers():
    c = PARENT.read_text()
    out = {}
    for m in re.finditer(r'  - slug: ([\w-]+)\n    name: ([^\n]+)\n    tag: ([^\n]+)\n', c):
        out[m.group(1)] = {"name": m.group(2), "tag": m.group(3)}
    return out


def q(metric, provider, chain, extra=""):
    return f'{metric}{{provider="{provider}", chain="{chain}"{extra}}}'


def provider_block(slug, meta, chain, label):
    name, tag = meta["name"], meta["tag"]
    formula = (
        f'50th percentile over 24h of client-side round-trip latency (ms) for a single '
        f'`eth_blockNumber` POST sent every 15s from 3 regions (us-east + eu-west + sgp) '
        f"to {name}'s no-key {label} endpoint."
    )
    b = []
    b.append(f"  - slug: {slug}")
    b.append(f"    name: {name}")
    b.append(f"    tag: {tag}")
    b.append(f'    formula: "{formula}"')
    b.append("    queries:")
    b.append(f'      p50: avg({q("ocb:rpc_latency_milliseconds:p50_24h", slug, chain)})')
    b.append(f'      p90: avg({q("ocb:rpc_latency_milliseconds:p90_24h", slug, chain)})')
    b.append(f'      p99: avg({q("ocb:rpc_latency_milliseconds:p99_24h", slug, chain)})')
    b.append(f'      mean: avg({q("ocb:rpc_latency_milliseconds:mean_24h", slug, chain)})')
    b.append(f'      success: sum({q("ocb:rpc_call:ok_rate_24h", slug, chain)}) / sum({q("ocb:rpc_call:rate_24h", slug, chain)})')
    b.append(f'      sample_size: sum({q("ocb:rpc_call:increase_24h", slug, chain)})')
    b.append(f'      series: avg(avg_over_time({q("rpc_latency_milliseconds", slug, chain)}[1h]))')
    b.append("      regions:")
    for region, promr in [("us-east", "us-east"), ("eu-west", "eu-west"), ("ap-southeast", "sgp")]:
        extra = ', region="' + promr + '"'
        b.append(f"        - region: {region}")
        b.append(f'          p50: avg({q("ocb:rpc_latency_milliseconds:p50_24h", slug, chain, extra)})')
        b.append(f'          series: avg_over_time({q("rpc_latency_milliseconds", slug, chain, extra)}[1h])')
    return "\n".join(b)


def yml_str(s):
    return '"' + s.replace('"', '\\"') + '"'


def block_scalar(s, indent="  "):
    lines = s.strip().split("\n")
    return "|\n" + "\n".join(indent + l for l in lines)


def gen_chain(chain, cfg, providers_meta):
    label = cfg["label"]
    num = cfg["num"]
    slug = f"{chain}-rpc"
    ed = EDITORIAL[chain]
    n = len(cfg["providers"])

    title = f"Fastest free {label} RPC, live no-key endpoint latency"
    seo_title = f"Fastest free {label} RPC 2026"
    seo_desc = (
        f"{{{{best_name}}}} leads free {label} RPC at {{{{best_p50}}}} "
        f"(eth_blockNumber p50, 24h). {n} no-key providers measured every 15s from 3 regions."
    )
    subtitle = (
        f"HTTP round-trip latency for eth_blockNumber against every free, no-key public "
        f"{label} RPC endpoint, audited every 15 seconds from 3 regions."
    )

    faq = [
        (
            f"What is the fastest free {label} RPC right now?",
            f"{{{{best_name}}}} currently leads at {{{{best_p50}}}} (`eth_blockNumber` p50 over the last 24h), measured against {n} no-key providers probed every 15 seconds from us-east, eu-west and Singapore. The leaderboard re-sorts continuously against fresh Prometheus samples, so the answer on this page is the answer right now, not a quarterly snapshot. Use the region tabs to see the leader from the origin closest to your deployment.",
        ),
        (
            f"Which {label} RPCs work without an API key?",
            f"The {n} providers on this page: " + ", ".join(providers_meta[p]["name"] for p in cfg["providers"]) + ". Every (provider, chain) pair was live-verified no-key before inclusion, and anything that key-gates, region-blocks or rate-limits below our 15-second cadence is excluded rather than listed with an asterisk.",
        ),
        (
            f"Does the fastest {label} RPC change by region?",
            "Frequently. The headline number averages three probe origins (us-east, eu-west, Singapore), but per-region leaders regularly diverge, a gateway that wins from Virginia can lose from Singapore by multiples. The region tabs at the top of the page re-scope every number on the page to a single origin; pick the one closest to where your requests actually originate.",
        ),
        (
            f"How is {label} RPC latency measured here?",
            f"One identical JSON-RPC POST (`eth_blockNumber`) every 15 seconds against each provider from each of 3 regions, with the same plain HTTP client. Wall-clock round-trip is recorded at millisecond precision; p50/p90/p99 are computed via Prometheus `quantile_over_time` over 24 hours. Responses are classified (`ok` / `http_err` / `jsonrpc_err` / `stale` / `timeout`) so an endpoint stuck on an old head or returning errors behind HTTP 200 is never ranked as fastest. The harness is open source and every number on this page is a public Prometheus query you can run yourself.",
        ),
        (ed["faq_extra_q"], ed["faq_extra_a"]),
    ]

    out = []
    out.append(f"# OpenChainBench. Bench № {num}")
    out.append("")
    out.append(f"slug: {slug}")
    out.append(f'number: "{num}"')
    out.append(f"title: {title}")
    out.append(f"seo_title: {yml_str(seo_title)}")
    out.append(f"seo_description: {yml_str(seo_desc)}")
    out.append(f"subtitle: {subtitle}")
    out.append("")
    out.append("category: RPCs")
    out.append("status: live")
    out.append("metric: RPC latency")
    out.append("unit: ms")
    out.append("higher_is_better: false")
    out.append("")
    out.append("seo_intro: " + block_scalar(ed["intro"]))
    out.append("")
    out.append("abstract: " + block_scalar(
        f"Per-chain member of the RPC latency cluster. We measure the round-trip latency of a single, identical RPC call (`eth_blockNumber`) against every no-key public {label} endpoint that sustains continuous probing, {n} providers, every 15 seconds, from us-east, eu-west and Singapore. The harness also classifies every response (ok / http_err / jsonrpc_err / stale / timeout) and audits archive depth every 5 minutes, so the leaderboard rewards sustained, honest availability rather than a fast error message. The cross-chain view lives on the parent rpc-capabilities benchmark; this page is the {label}-scoped answer with per-region breakdowns as a first-class dimension."
    ))
    out.append("")
    out.append("methodology:")
    for m in SHARED_METHO:
        out.append(f"  - {yml_str(m)}")
    out.append(f'  - "Chain scope: every query on this page is pinned to chain=\\"{chain}\\". Provider coverage: {n} no-key endpoints ({", ".join(providers_meta[p]["name"] for p in cfg["providers"])}). Exclusions follow the cluster-wide rules documented on the parent benchmark."')
    out.append("")
    out.append("findings:")
    for f in ed["findings"]:
        out.append(f"  - {yml_str(f)}")
    out.append("")
    out.append("faq:")
    for qq, aa in faq:
        out.append(f"  - q: {yml_str(qq)}")
        out.append(f"    a: {yml_str(aa)}")
    out.append("")
    out.append("source: https://github.com/ChainBench/OpenChainBench/tree/main/harnesses/rpc-capabilities")
    out.append("")
    out.append("prometheus:")
    out.append("  window: 24h")
    out.append("  freshness_metric: rpc_latency_milliseconds")
    out.append("")
    out.append("# Per-cell (region) ranking matrix for scoped badge claims. Chain is")
    out.append("# fixed for the whole bench, so cells key on region alone.")
    out.append(f'rank_matrix_query: avg by (provider, region) (ocb:rpc_latency_milliseconds:p50_24h{{chain="{chain}"}})')
    out.append("")
    out.append("# Region is the only dimension: chain is baked into every query.")
    out.append("dimensions:")
    out.append("  region:")
    out.append("    - { value: all,     label: All regions }")
    out.append("    - { value: us-east, label: US-East }")
    out.append("    - { value: eu-west, label: EU-West }")
    out.append("    - { value: sgp,     label: Singapore }")
    out.append("")
    out.append("providers:")
    for p in cfg["providers"]:
        out.append(provider_block(p, providers_meta[p], chain, label))
        out.append("")
    return "\n".join(out)


def main():
    providers_meta = parse_parent_providers()
    for chain, cfg in CHAINS.items():
        missing = [p for p in cfg["providers"] if p not in providers_meta]
        assert not missing, f"{chain}: missing provider meta {missing}"
        path = ROOT / "benchmarks" / f"{chain}-rpc.yml"
        path.write_text(gen_chain(chain, cfg, providers_meta) + "\n")
        print(f"wrote {path.name} ({cfg['num']}, {len(cfg['providers'])} providers)")


if __name__ == "__main__":
    main()
