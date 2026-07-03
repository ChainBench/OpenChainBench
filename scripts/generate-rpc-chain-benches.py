#!/usr/bin/env python3
"""Generator for the per-chain RPC benchmark cluster (044-053 majors,
055-066 long-tail expansion of 2026-07-03).

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
    # Long-tail expansion (2026-07-03 sweep, provider order mirrors
    # harnesses/rpc-capabilities/cmd/script/config.go).
    "sonic":     {"num": "055", "label": "Sonic",     "providers": ["publicnode", "drpc", "1rpc", "tenderly", "lava", "sonic-official"]},
    "gnosis":    {"num": "056", "label": "Gnosis",    "providers": ["publicnode", "drpc", "1rpc", "tenderly", "nodies", "gnosis-official"]},
    "celo":      {"num": "057", "label": "Celo",      "providers": ["publicnode", "drpc", "1rpc", "tenderly", "celo-official"]},
    "moonbeam":  {"num": "058", "label": "Moonbeam",  "providers": ["publicnode", "drpc", "1rpc", "tenderly", "moonbeam-official"]},
    "unichain":  {"num": "059", "label": "Unichain",  "providers": ["publicnode", "drpc", "1rpc", "tenderly", "unichain-official"]},
    "blast":     {"num": "060", "label": "Blast",     "providers": ["publicnode", "drpc", "tenderly", "blast-official"]},
    "taiko":     {"num": "061", "label": "Taiko",     "providers": ["publicnode", "drpc", "tenderly", "taiko-official"]},
    "berachain": {"num": "062", "label": "Berachain", "providers": ["publicnode", "drpc", "tenderly", "berachain-official"]},
    # seo_label keeps "Fastest free zkSync RPC 2026" inside the 26-31
    # char window ("zkSync Era" pushes it to 32).
    "zksync":    {"num": "063", "label": "zkSync Era", "seo_label": "zkSync", "providers": ["drpc", "1rpc", "tenderly", "zksync-official"]},
    "cronos":    {"num": "064", "label": "Cronos",    "providers": ["publicnode", "drpc", "1rpc", "cronos-official"]},
    "fraxtal":   {"num": "065", "label": "Fraxtal",   "providers": ["publicnode", "drpc", "tenderly", "fraxtal-official"]},
    "soneium":   {"num": "066", "label": "Soneium",   "providers": ["publicnode", "drpc", "tenderly", "soneium-official"]},
}

# Provider metadata for endpoints that only exist on the long-tail
# chains (slugs mirror config.go; the parent rpc-capabilities.yml only
# carries the majors-era roster). Names follow the site convention for
# chain-official endpoints: brand name, "official" lives in the tag.
EXTRA_PROVIDERS = {
    "sonic-official":     {"name": "Sonic Labs", "tag": "Sonic Labs public RPC, Sonic mainnet only"},
    "gnosis-official":    {"name": "Gnosis",     "tag": "Gnosis chain-official RPC (rpc.gnosischain.com)"},
    "celo-official":      {"name": "Celo (Forno)", "tag": "cLabs Forno public RPC, Celo mainnet only"},
    "moonbeam-official":  {"name": "Moonbeam",   "tag": "Moonbeam Foundation public RPC, Moonbeam only"},
    "unichain-official":  {"name": "Unichain",   "tag": "Uniswap Labs public RPC, Unichain mainnet only"},
    "blast-official":     {"name": "Blast",      "tag": "Chain-official RPC, edge-terminated (see findings)"},
    "taiko-official":     {"name": "Taiko",      "tag": "Taiko Labs public RPC, Taiko mainnet only"},
    "berachain-official": {"name": "Berachain",  "tag": "Berachain Foundation public RPC, Berachain only"},
    "zksync-official":    {"name": "zkSync",     "tag": "Matter Labs public RPC, zkSync Era only"},
    "cronos-official":    {"name": "Cronos",     "tag": "Cronos Labs public RPC, Cronos EVM only"},
    "fraxtal-official":   {"name": "Fraxtal",    "tag": "Frax-operated public RPC, Fraxtal mainnet only"},
    "soneium-official":   {"name": "Soneium",    "tag": "Sony Block Solutions public RPC, Soneium mainnet only"},
}

# Per-(chain, provider) tag overrides. The parent-yml tags encode
# majors-era facts (Tenderly "9 chains", Lava "ETH + Arbitrum no-key")
# that are stale on the long-tail pages; existing 044-053 output must
# stay byte-identical, so the corrections apply per chain here.
TAG_OVERRIDES = {
    ("sonic", "lava"): "Decentralized permissionless RPC mesh (sonic.lava.build, open no-key)",
}
for _c in ("sonic", "gnosis", "celo", "moonbeam", "unichain", "blast",
           "taiko", "berachain", "zksync", "fraxtal", "soneium"):
    TAG_OVERRIDES[(_c, "tenderly")] = "Multi-chain public gateway, no key"

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
    "sonic": {
        "intro": "Sonic ties Gnosis for the largest cohort in the long-tail expansion: 6 no-key providers, including Sonic Labs' own `rpc.soniclabs.com` and the only keyless Lava endpoint outside Ethereum and Arbitrum, `sonic.lava.build` answers no-key while every other Lava subdomain 403s without an API key. Every provider gets the identical `eth_blockNumber` probe every 15 seconds from us-east, eu-west and Singapore, with stale-head detection against the cross-provider tip.",
        "findings": [
            "{{best_name}} currently leads free Sonic RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 6 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) illustrates the long-tail pattern: it wins 10 of the 12 chains in this expansion on the 3-region average, not by posting the fastest single-region peak but by answering every origin from a nearby anycast edge.",
            "{{name:tenderly}} tells the opposite story: roughly 330 ms in every region, the flat signature of single-origin routing. The same gateway is competitive on Ethereum and Base, so this is a per-chain routing decision, not a capacity problem.",
            "{{name:lava}} makes Sonic a curiosity: `sonic.lava.build` is the only Lava subdomain that answers no-key outside eth1/arb1, so this page is the cluster's only long-tail read on the Lava mesh.",
        ],
        "faq_extra_q": "Why does Lava appear on Sonic but on no other long-tail chain?",
        "faq_extra_a": "Lava publishes `*.lava.build` subdomains for many chains, but nearly all of them return 403 without an API key. `sonic.lava.build` is the exception: it passed our no-key verification (eth_chainId match plus sustained probing) and has held the 15-second cadence since. Every (provider, chain) pair in this cluster is admitted on measured behavior, not on a provider's published chain list.",
    },
    "gnosis": {
        "intro": "Gnosis is the cluster's clearest proof that official does not mean fast: the chain-official `rpc.gnosischain.com` is the slowest endpoint we measure on the chain, around 433 ms p50 on the 3-region average, while five third-party gateways beat it, including Nodies, whose POKT-backed infrastructure reaches Gnosis as its only chain in this 12-chain expansion. 6 no-key providers, the same `eth_blockNumber` call every 15 seconds, three regions.",
        "findings": [
            "{{best_name}} currently leads free Gnosis RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 6 measured providers.",
            "The chain-official endpoint anchors the wrong end of the board: ~433 ms p50 with a similar profile from every region, slower than every gateway on this page. It is honest about its blocks; it is just slow.",
            "{{name:nodies}} ({{p50:nodies}}) is the quiet story of the expansion: Gnosis is the only long-tail chain it qualifies on, and it serves the chain well, a POKT-routed gateway beating the house endpoint by a wide margin.",
            "{{name:drpc}} ({{p50:drpc}}) shows its usual anycast consistency here, part of the pattern that has it leading 10 of the 12 long-tail chains on the 3-region average.",
        ],
        "faq_extra_q": "Should I use rpc.gnosischain.com as my Gnosis RPC?",
        "faq_extra_a": "Only as a fallback. It is the slowest endpoint we measure on Gnosis, roughly 433 ms median across three regions, several times the gateway tier, though its reliability and head freshness are fine. The measured leaders above serve the same chain with a fraction of the round trip; keep the official endpoint in the rotation for redundancy rather than as primary.",
    },
    "celo": {
        "intro": "Celo brings 5 no-key providers anchored by Forno (`forno.celo.org`), cLabs' public endpoint that predates most of the gateway industry. Since Celo's migration to an Ethereum L2 the RPC surface is standard EVM, so the multi-chain gateways (PublicNode, dRPC, 1RPC, Tenderly) compete directly with the house endpoint on the identical `eth_blockNumber` probe every 15 seconds from three regions.",
        "findings": [
            "{{best_name}} currently leads free Celo RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 5 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) extends its long-tail run here, 10 of the 12 expansion chains fall to it on the 3-region average, a consistency win built on anycast rather than any single-region record.",
            "Forno remains a serviceable default years after launch, but it is one origin: at least two of our three probe regions always see it with an ocean in the path, which the region tabs make visible.",
            "{{name:tenderly}} shows the same long-tail collapse measured across this expansion: ~330 ms flat in all three regions, single-origin routing behind a gateway that is genuinely fast on the majors.",
        ],
        "faq_extra_q": "Is Forno still the right default RPC for Celo?",
        "faq_extra_a": "Forno is stable and honest, but it is a single origin, so at least two of our three probe regions always pay cross-ocean latency to reach it. The current leader above ({{best_name}} at {{best_p50}}) reflects the 3-region average; if your traffic is single-region, open that region's tab, Forno's ranking moves markedly by origin.",
    },
    "moonbeam": {
        "intro": "Moonbeam, Polkadot's EVM parachain, fields 5 no-key providers including the Moonbeam Foundation's `rpc.api.moonbeam.network`. One integration trap surfaced in our verification sweep: 1RPC addresses the chain by its token code, so the working path is `1rpc.io/glmr` and the intuitive `/moonbeam` returns HTTP 400. Probes run every 15 seconds from three regions with full response classification.",
        "findings": [
            "{{best_name}} currently leads free Moonbeam RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 5 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) carries its anycast-consistency pattern onto a Polkadot parachain unchanged: same probe, same edge behavior, same 3-region steadiness that wins it 10 of the 12 long-tail chains.",
            "{{name:1rpc}} is reachable only at the token-code path `1rpc.io/glmr`; the obvious `/moonbeam` URL 400s, the kind of detail no status page documents and this bench exists to encode.",
            "{{name:tenderly}} posts the expansion's recurring flat ~330 ms in every region on Moonbeam too, single-origin routing rather than the edge network it runs for the major chains.",
        ],
        "faq_extra_q": "Why does 1RPC's Moonbeam endpoint use /glmr instead of /moonbeam?",
        "faq_extra_a": "1RPC keys several chain paths on native-token tickers, and GLMR is Moonbeam's token, so the working endpoint is `1rpc.io/glmr` while `1rpc.io/moonbeam` returns HTTP 400. Our harness verified the chain identity behind the path (eth_chainId 1284) before admitting it, so the numbers above are guaranteed to be Moonbeam mainnet and not a lookalike.",
    },
    "unichain": {
        "intro": "Unichain, Uniswap Labs' OP Stack rollup, fields 5 no-key providers including the house `mainnet.unichain.org`. For a chain this young the gateway coverage is unusually complete, PublicNode, dRPC, 1RPC and Tenderly all sustain no-key probing at our 15-second cadence, so the official endpoint faces a full gateway tier from day one. Three regions, identical probes, stale-head detection.",
        "findings": [
            "{{best_name}} currently leads free Unichain RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 5 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) treats Unichain like every other chain in the expansion, and that is the point: 10 of 12 long-tail wins on the 3-region average come from routing every probe to a nearby edge, chain age irrelevant.",
            "The official sequencer-adjacent endpoint has the locational advantage on paper; the region tabs show whether it holds against gateways that terminate at the probe's nearest edge instead of one home region.",
            "{{name:tenderly}} repeats its long-tail signature here, roughly 330 ms from all three origins at once, while remaining competitive on the majors, the clearest sign its public gateway routes small chains through a single origin.",
        ],
        "faq_extra_q": "Should I use mainnet.unichain.org or a gateway for Unichain?",
        "faq_extra_a": "Check the region tab nearest your deployment. Chain-official endpoints are typically a single origin, so they can only be close to one of our three probes, while anycast gateways answer everywhere. On the 3-region average the current leader is {{best_name}} at {{best_p50}}; a primary-plus-fallback pair from the top of this page is the resilient default for a chain this young.",
    },
    "blast": {
        "intro": "Blast is the expansion's measurement cautionary tale. The chain-official `rpc.blast.io` answers in roughly 2 ms from all three probe regions at once, which no single origin can do: Virginia, Amsterdam and Singapore are separated by 80+ ms round trips at the speed of light. The endpoint terminates at an edge network. Our stale-head detection confirms the blocks it serves are fresh, but a sub-5 ms number measures the edge handshake, not the chain. 4 no-key providers, identical probes, three regions.",
        "findings": [
            "{{best_name}} currently leads free Blast RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "`rpc.blast.io` posts ~2 ms in every region simultaneously, physically impossible for one origin. Read it as an edge-terminated endpoint: heads are fresh per our stale detection, but the latency column measures CDN termination rather than a node round trip, the same class of caution we document for Cloudflare-eth.",
            "{{name:drpc}} ({{p50:drpc}}) is the honest-infrastructure comparison point: anycast consistency across the three regions with real node round trips behind it, the profile that wins it 10 of the 12 expansion chains.",
            "{{name:tenderly}} sits at the expansion's familiar flat ~330 ms in all regions on Blast, single-origin routing on a gateway that is genuinely quick on the major chains.",
        ],
        "faq_extra_q": "Is rpc.blast.io really that fast, or is something else going on?",
        "faq_extra_a": "Something else. Two milliseconds simultaneously from Virginia, Amsterdam and Singapore is below the physical round-trip floor for any single origin, so the endpoint is answering at an anycast/CDN edge. Our stale-head detection shows the blocks it returns are current, so it is not serving a stale cache today, but edge termination means the latency figure describes the edge network, not node processing. We keep it ranked with the caveat documented, exactly as we do for Cloudflare's fast-but-permissioned Ethereum endpoint.",
    },
    "taiko": {
        "intro": "Taiko, the based rollup where Ethereum validators sequence L2 blocks, fields 4 no-key providers. Our verification sweep caught one routing quirk worth encoding: Tenderly serves the chain only at the `taiko-mainnet` gateway slug, the plain `/taiko` path 404s. Probes run every 15 seconds from us-east, eu-west and Singapore with stale-head detection against the cross-provider tip.",
        "findings": [
            "{{best_name}} currently leads free Taiko RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) brings the same anycast steadiness that carries it to 10 wins across the 12 expansion chains; based sequencing on the chain side changes nothing about who answers RPC reads fastest.",
            "{{name:tenderly}} both qualifies and disappoints: reachable only at the `taiko-mainnet` slug, and once reached it shows the flat ~330 ms three-region signature of a single origin, while the same gateway is competitive on the majors.",
            "A 4-provider field leaves little redundancy: one gateway incident visibly reshuffles the 24h board, which is why the success-rate column and region tabs matter more here than on the deep Ethereum cohort.",
        ],
        "faq_extra_q": "Which free Taiko RPC should production traffic use?",
        "faq_extra_a": "Start from {{best_name}} ({{best_p50}} on the 3-region average) and pair it with the runner-up as fallback; in a 4-provider field a single degradation reshuffles the board. If you configure Tenderly manually, note its gateway path is `taiko-mainnet`, the intuitive `/taiko` path 404s, a detail our probes encode but provider directories rarely do.",
    },
    "berachain": {
        "intro": "Berachain's proof-of-liquidity L1 fields 4 no-key providers: the Foundation's `rpc.berachain.com` plus PublicNode, dRPC and Tenderly. A thin cohort is itself a signal, several sibling chains failed the cluster's four-keyless-provider bar entirely, so each endpoint that qualifies here carries more of the redundancy burden. Identical probes every 15 seconds, three regions, full response classification.",
        "findings": [
            "{{best_name}} currently leads free Berachain RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) extends its expansion-wide consistency run to Berachain, the anycast profile that takes 10 of the 12 long-tail chains on the 3-region average.",
            "{{name:tenderly}} shows the long-tail single-origin signature again, roughly 330 ms from every region, a sharp contrast with its performance on the chains its edge network actually fronts.",
            "The Foundation endpoint gives the chain a credible house baseline; whether it beats the gateways depends on your origin, which is exactly what the per-region tabs are for.",
        ],
        "faq_extra_q": "Are free Berachain RPCs ready for production traffic?",
        "faq_extra_a": "The four qualifying endpoints all sustain our 15-second cadence with high measured success rates, which is the floor for production reads. The real constraint is redundancy: with 4 providers, one incident removes a quarter of your options, so run the current leader ({{best_name}}, {{best_p50}}) as primary with the runner-up wired as fallback and let this page arbitrate after incidents.",
    },
    "zksync": {
        "intro": "zkSync Era is the only chain in our entire probe matrix with no PublicNode endpoint: both plausible subdomains 404, a genuine rarity for a provider that covers 70+ chains. That leaves dRPC, 1RPC, Tenderly and Matter Labs' own `mainnet.era.zksync.io` answering the identical `eth_blockNumber` probe every 15 seconds from three regions, with stale-head detection against the cross-provider tip.",
        "findings": [
            "{{best_name}} currently leads free zkSync Era RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "No PublicNode is the structural headline: the near-universal default provider simply does not serve zkSync Era (both candidate subdomains 404), so dapps that template PublicNode URLs per chain need a different answer here.",
            "{{name:drpc}} ({{p50:drpc}}) picks up the default-provider role instead, with the anycast consistency that wins it 10 of the 12 expansion chains on the 3-region average.",
            "{{name:tenderly}} runs zkSync through the same single-origin path as the rest of the long tail, a flat ~330 ms from all three regions, despite marketing the chain as a first-class network.",
        ],
        "faq_extra_q": "Why is PublicNode not listed for zkSync Era?",
        "faq_extra_a": "Because it does not serve the chain: both plausible PublicNode subdomains returned 404 in our 2026-07-03 verification sweep, making zkSync Era the only chain we probe without a PublicNode endpoint. The bench lists what actually answers, not what coverage pages claim, so the leaderboard has 4 providers and {{best_name}} ({{best_p50}}) currently leads them.",
    },
    "cronos": {
        "intro": "Cronos fields 4 no-key providers and encodes two integration traps from our sweep: PublicNode serves the chain at `cronos-evm-rpc.publicnode.com` (the intuitive `cronos-rpc` subdomain resolves but returns non-JSON), and 1RPC uses the ticker path `1rpc.io/cro`. Tenderly's public gateway does not reach Cronos, making this one of the few pages in the cluster without it. Probes every 15 seconds from three regions.",
        "findings": [
            "{{best_name}} currently leads free Cronos RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "{{name:publicnode}} ({{p50:publicnode}}) hides behind a naming trap: the working subdomain is `cronos-evm-rpc`, while `cronos-rpc` resolves and then returns non-JSON, a failure mode that looks like an outage if you guessed the URL.",
            "{{name:drpc}} ({{p50:drpc}}) delivers its usual three-region steadiness, the anycast pattern behind its 10-of-12 record across this long-tail expansion.",
            "MeowRPC, historically listed for Cronos in RPC directories, is absent by measurement: its long-tail DNS is gone and the provider appears defunct outside a handful of legacy chains.",
        ],
        "faq_extra_q": "Why isn't MeowRPC listed on Cronos?",
        "faq_extra_a": "We tried it. MeowRPC's long-tail endpoints no longer resolve (DNS gone), and the provider appears defunct outside a few legacy chains, so it failed the live verification, eth_chainId match plus sustained probing, that gates admission to this cluster. Directories still listing it are copying stale metadata; this bench only ranks endpoints that answer.",
    },
    "fraxtal": {
        "intro": "Fraxtal, Frax's OP Stack rollup, fields 4 no-key providers: PublicNode, dRPC, Tenderly and Frax's own `rpc.frax.com`. The four-provider floor it just clears is the cluster's deliberate admission bar, chains that could not field four keyless endpoints (Mode, Zora, Abstract) were left out of the expansion entirely rather than shipped as two-row leaderboards. Identical probes every 15 seconds, three regions.",
        "findings": [
            "{{best_name}} currently leads free Fraxtal RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "{{name:drpc}} ({{p50:drpc}}) closes out its expansion pattern here, anycast consistency across us-east, eu-west and Singapore, the profile that wins it 10 of the 12 new chains on the 3-region average.",
            "{{name:tenderly}} posts the recurring long-tail flat line, ~330 ms from every origin at once, single-origin routing on a gateway whose edge network clearly does not front Fraxtal.",
            "Fraxtal sits exactly at the cluster's admission bar of 4 keyless providers, the fact that Mode, Zora and Abstract missed; a thin field makes the success-rate column the tiebreaker the median cannot show.",
        ],
        "faq_extra_q": "Why are chains like Mode, Zora or Sei missing from this cluster?",
        "faq_extra_a": "Each failed a specific admission test. Mode, Zora and Abstract could not field 4 keyless providers, below the bar for a meaningful leaderboard. Sei was excluded because dRPC caches `eth_blockNumber` there, poisoning the exact probe we rank on. opBNB fell out because 1RPC returns 429 at our 15-second cadence, leaving only 3 solid providers. The cluster only ships chains where the comparison is honest.",
    },
    "soneium": {
        "intro": "Soneium, Sony's OP Stack rollup, is the long-tail chain where the official endpoint actually wins: `rpc.soneium.org` leads at roughly 17 ms on the 3-region average, distributed official infrastructure that answers near every probe origin while keeping fresh heads in our stale detection. 4 no-key providers, the identical `eth_blockNumber` call every 15 seconds from us-east, eu-west and Singapore.",
        "findings": [
            "{{best_name}} currently leads free Soneium RPC at {{best_p50}} (`eth_blockNumber` p50, 24h) across 4 measured providers.",
            "The official `rpc.soneium.org` is one of the expansion's two exceptions to the dRPC sweep: ~17 ms on the 3-region average with fresh heads throughout, a chain operator that fronts its RPC properly across regions instead of pointing DNS at one box.",
            "{{name:drpc}} ({{p50:drpc}}) still posts its trademark three-region consistency here; it just meets the rare official endpoint built on the same playbook.",
            "{{name:tenderly}} closes the pattern the expansion documents everywhere: roughly 330 ms flat in all three regions on Soneium, single-origin routing behind a gateway that is competitive on the majors.",
        ],
        "faq_extra_q": "Is the official Soneium RPC actually the best choice?",
        "faq_extra_a": "Currently yes, and that is unusual: across the 12-chain long-tail expansion only two chains resist the gateway tier, and `rpc.soneium.org` is the clearest case, leading the 3-region average at around 17 ms while our stale-head checks stay clean. The usual free-tier caveats (no SLA, shared limits) still apply, so keep {{name:drpc}} or {{name:publicnode}} wired as fallback.",
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
    seo_title = f"Fastest free {cfg.get('seo_label', label)} RPC 2026"
    assert 26 <= len(seo_title) <= 31, f"{chain}: seo_title is {len(seo_title)} chars: {seo_title!r}"
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
        meta = dict(providers_meta[p])
        if (chain, p) in TAG_OVERRIDES:
            meta["tag"] = TAG_OVERRIDES[(chain, p)]
        out.append(provider_block(p, meta, chain, label))
        out.append("")
    return "\n".join(out)


def main():
    providers_meta = {**parse_parent_providers(), **EXTRA_PROVIDERS}
    for chain, cfg in CHAINS.items():
        missing = [p for p in cfg["providers"] if p not in providers_meta]
        assert not missing, f"{chain}: missing provider meta {missing}"
        path = ROOT / "benchmarks" / f"{chain}-rpc.yml"
        path.write_text(gen_chain(chain, cfg, providers_meta) + "\n")
        print(f"wrote {path.name} ({cfg['num']}, {len(cfg['providers'])} providers)")


if __name__ == "__main__":
    main()
