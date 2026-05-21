# France Cryptos × OpenChainBench — Benchmark Roadmap

10 nouveaux benchmarks proposés, validés sur faisabilité technique (endpoints réels testés) et économique (free / free-tier soutenable).

Méthodo : chaque candidat a été testé par un agent dédié (curl + WebFetch sur les APIs cibles, vérification rate limits, fallbacks). Verdict = `GREEN` (free, méthodo clean) / `PARTIAL` (free avec scope réduit ou caveat) / `BLOCKED` (paywall / infra coûteuse).

---

## 1. Positionnement stratégique

France Cryptos demande une couverture éditoriale qui chevauche largement DeFiLlama / TokenTerminal / Artemis / Glassnode. On n'essaie pas de les rejouer — leurs équipes pleins-temps gagnent ce match.

Le **rôle d'OCB** dans ce partenariat = produire des **benchmarks comparatifs reproductibles** qui répondent à des questions éditoriales précises que les concurrents ne tranchent pas :

- *"Qui tient sa promesse de buyback ?"*
- *"Qui dilue, et combien d'impact ça a eu historiquement ?"*
- *"Quel oracle dévie ?"*
- *"Quel validator paie réellement ?"*
- *"Quel issuer stablecoin est transparent ?"*

Chaque bench OCB doit donc produire **(a) un classement public + (b) un seuil/déclencheur de news + (c) un endpoint Prometheus consommable par un agent éditorial / bot TG**.

---

## 2. Matrice de faisabilité

| # | Bench | Verdict | Coût infra | Bottleneck principal | Priorité |
|---|---|---|---|---|---|
| 017 | Real Earnings | 🟡 PARTIAL | $0 | DeFiLlama `/emissions` désormais 402. Proxy : emissions schedule via vesting on-chain | P3 |
| 018 | Buyback Execution Audit | 🟢 GREEN (3 protos) | $0 | dYdX = stack Cosmos (skip v1), Aave AFC addr à confirmer | **P1** |
| 019 | Sustainable DAU | 🟡 PARTIAL | $0 (light) | Cluster analysis O(N²) infaisable free. Heuristiques de surface seulement | P4 |
| 020 | Perp Funding Spread | 🟡 PARTIAL (4/8 DEX) | $0 | Drift/GMX/Jupiter = lecture on-chain, pas REST | **P2** |
| 021 | BTC On-Chain Indicators | 🟡 PARTIAL (3/8) | $0 light / ~50€/mo Hetzner full | SOPR/MVRV/NUPL = nœud BTC full (740 GB). Free = Puell / Hash Ribbons / MPI proxy | P3 |
| 022 | Token Unlocks Pressure | 🟢 GREEN | $0 | CryptoRank Next.js scraping fragile (`buildId` rotates) | **P1** |
| 023 | Stablecoin Issuer Transparency | 🟡 PARTIAL (4/6 issuers) | $0 | USDT/FDUSD = SPA + PDF hostiles. USDC/DAI/PYUSD/USDe clean | P3 |
| 024 | Bridge Flow Anomaly | 🟡 PARTIAL | $0 | DeFiLlama bridges désormais 402. Wormhole couvre ≠ canonical L2 bridges | P2 |
| 025 | Oracle Deviation | 🟢 GREEN | $0 | Uniswap TWAP = code custom (sqrtPriceX96, multi-hop). v1 sans TWAP | **P1** |
| 026 | Validator Economics Net of MEV | 🟢 GREEN SOL/HL / 🟡 PARTIAL ETH | $0 | ETH = besoin index validators (top-N par stake en MVP, sinon nœud beacon) | **P1** (SOL+HL) |

---

## 3. Specs détaillées par bench

### Bench № 017 — Real Earnings *(P3, PARTIAL)*

**Question** : "Quel protocole est réellement profitable une fois les incentives token déduits ?"

**Méthodo proposée** : `sustainability_ratio = revenue_30d / (unlocked_supply_30d × price_avg_30d)`. Pas strictement "earnings users-distributed" — proxy "emissions schedule valorisé". Documenter le caveat.

**Sources retenues** (free) :
- `api.llama.fi/summary/fees/{slug}?dataType=dailyRevenue` — pas de clé, ~300 req/5min raisonnable
- `api.coingecko.com/api/v3/coins/{id}/market_chart` — 30 req/min, 10k/mois
- Vesting contracts on-chain via RPC public + Etherscan v2 (5 req/s)

**Sources écartées (paywall)** : DeFiLlama `/emissions` (402), Tokenomist (pas d'API publique), Token Terminal (full paywall).

**Métriques Prom** :
```
ocb_protocol_revenue_30d_usd{protocol, sector}
ocb_protocol_emissions_value_30d_usd{protocol}
ocb_protocol_sustainability_ratio{protocol}
```

**Bottleneck** : "incentives" ≠ "emissions schedule". V1 = proxy avec disclaimer. V2 ($300/mo DeFiLlama Pro) débloque la vraie métrique.

---

### Bench № 018 — Buyback Execution Audit *(P1, GREEN)*

**Question** : "Les protocoles font-ils vraiment leurs buybacks annoncés ?"

**Méthodo** : `executed_USD / promised_USD` sur fenêtres 7d / 30d, mesuré on-chain par parsing du buyback wallet.

**Scope v1 — 3 protocoles clean** :

| Protocole | Wallet | Endpoint | Promesse publique |
|---|---|---|---|
| **Hyperliquid** | `0xfefe...fefe` (Assistance Fund) | `api.hyperliquid.xyz/info` (`userFills` + `spotClearinghouseState`) | 97% des fees → AF (docs + gov) |
| **GMX** | Treasury `0x68863dDE14303BcED249cA8ec6AF85d4694dea6A` (Arbitrum) | Etherscan v2 `chainid=42161` | 27% fees → buyback distrib stakers $90 |
| **Sky / Maker** | `0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB` (SBE receiver) | Etherscan v2 | Smart Burn Engine déterministe : surplus > 50M DAI → buyback MKR sur Uniswap V2 |

**Sources retenues** :
- Hyperliquid Info API — public, no key, ~100 req/min raisonnable
- Etherscan API v2 — 1 clé free, 5 req/s, 100k/jour, multi-chain (ETH + Arb + Base + OP unifié)
- DeFiLlama `summary/fees` — calcul du dénominateur `promised_USD = revenue × % engagé`
- CoinGecko — USD-ification des token amounts

**Reporter v2** : dYdX (stack Cosmos, autre scraper), Aave (adresse AFC à confirmer via TokenLogic dashboard), Jupiter (besoin adresse exacte Litterbox Trust).

**Métriques Prom** :
```
ocb_buyback_executed_usd{protocol, window}
ocb_buyback_promised_usd{protocol, window}
ocb_buyback_ratio{protocol, window}
```

---

### Bench № 019 — Sustainable DAU *(P4, PARTIAL — à reconsidérer)*

**Question** : "Combien d'utilisateurs réels (hors sybil/bots) un protocole a vraiment ?"

**Verdict honnête** : sans Dune/Flipside payant ou indexer custom, l'angle "real DAU" est creux. Le cluster analysis O(N²) est infaisable en free tier. Seules les heuristiques de surface tournent.

**Si on garde v1 (avec disclaimer fort)** :
- 3 protocoles : Base, Uniswap, Jupiter
- 3 heuristiques : wallet age <30j, valeur USD médiane tx, % activité dans seul protocole audité
- Refresh quotidien (pas continu)
- Back-test contre dataset public `LayerZero-Labs/sybil-report` pour valider precision/recall
- Métrique : `ocb_sustainable_dau_ratio{protocol}` avec disclaimer "v1 = heuristiques de surface, pas clustering"

**Reco** : reporter à v2 quand budget ETL custom (Postgres + indexer) débloqué. Sortir un faux "real DAU" décrédibiliserait OCB.

---

### Bench № 020 — Perp Funding Spread *(P2, PARTIAL → GREEN sur 4 DEX)*

**Question** : "Quel DEX perp a le funding le plus exploitable / le mieux aligné spot ?"

**Scope v1 — 5 sources REST publiques** :

| Source | Endpoint | Cadence funding |
|---|---|---|
| Binance (ref CEX) | `fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT` | 8h |
| Hyperliquid | `api.hyperliquid.xyz/info` (POST `type=metaAndAssetCtxs`) | 1h |
| dYdX v4 | `indexer.dydx.trade/v4/perpetualMarkets?ticker=BTC-USD` | 1h |
| Aster | `fapi.asterdex.com/fapi/v1/premiumIndex?symbol=BTCUSDT` | 8h (clone Binance) |
| Vertex | `archive.prod.vertexprotocol.com/v1` | 1h (format à reverse) |

**Reporter v2** :
- GMX v2 — funding via `Reader` contract Arbitrum (eth_call)
- Drift — SDK + RPC Solana (Helius free)
- Jupiter Perps — décodage `custody` accounts Solana

**Normalisation obligatoire** : 3 formats (1h, 8h, per-second) → métrique annualized commune `funding_rate_apr`.

**Métriques Prom** :
```
ocb_perp_funding_rate_apr{dex, market}
ocb_perp_funding_spread_bps{market, dex_a, dex_b}
ocb_perp_funding_next_at_seconds{dex, market}
```

---

### Bench № 021 — BTC On-Chain Indicators *(P3, PARTIAL — repositionnement)*

**Verdict** : "Glassnode replica full open-source" demande nœud BTC full (740 GB chain + 120 GB electrs, ~50€/mo Hetzner bare-metal — pas Railway). Décision business à prendre.

**Reposition v1** : "OCB Mining & Cycle Indicators" sur 3 indicateurs faisables 100% free :

| Indicateur | Source free | Faisabilité |
|---|---|---|
| **Puell Multiple** | `blockchain.info/charts/miners-revenue` + price (Coingecko) / MA365 | 🟢 |
| **Hash Ribbons** | `mempool.space/api/v1/mining/hashrate/3y` (MA30/MA60) | 🟢 |
| **MPI proxy** | `mempool.space` outflows top mining pool addresses + price | 🟡 (liste curated à maintenir) |

**Sources testées mortes / payantes** :
- Glassnode `/v1/metrics/*` → 401 (full paywall)
- Coin Metrics community → 403 sur `SOPR`, `CapRealUSD`, `MVRV` (free = `PriceUSD` only)
- LookIntoBitcoin / Newhedge → 404 (UI-only, pas d'API)
- Bitaps UTXO age → endpoint mort

**Reporter v2 (avec nœud BTC)** : SOPR, MVRV, NUPL, Supply in Profit, Reserve Risk, Accumulation Trend Score.

**Métriques Prom** :
```
ocb_btc_puell_multiple
ocb_btc_hash_ribbon_short
ocb_btc_hash_ribbon_long
ocb_btc_mpi_proxy
```

---

### Bench № 022 — Token Unlock Pressure *(P1, GREEN)*

**Question** : pour chaque unlock à venir, distribution conditionnelle de l'impact prix attendu (basé sur 200 derniers unlocks comparables).

**Sources retenues** :
- **CryptoRank Next.js data routes** (non-API, gratuit, sans auth) :
  - `cryptorank.io/_next/data/<buildId>/en/token-unlock.json?page=N` → calendrier complet, 415 tokens
  - `.../en/price/<slug>/vesting.json` → schedule complet par token (batches passés + futurs)
  - Bottleneck : `buildId` rotate à chaque deploy CR → scraper la home pour l'extraire dynamiquement (1 req/run)
- **DeFiLlama coins API** (free, no auth) :
  - `coins.llama.fi/chart/coingecko:<id>?start=<ts>&span=<days>&period=1d` → prix daily depuis launch
  - Burst 5 req séquentielles ~200ms sans throttling observé

**Sources écartées** : DeFiLlama `/emissions` (402), Tokenomist (pas d'API publique), CryptoRank API officielle (401 sans clé), CoinGecko `market_chart/range` (bloqué free), Messari (paywall).

**Risque schéma** : CryptoRank scraping non-API → monitor schema drift toutes les heures (test canary).

**Métriques Prom** :
```
ocb_unlock_upcoming{token, date, allocation}
ocb_unlock_expected_impact_pct{token, date}      # médiane conditionnelle bucket %supply
ocb_unlock_historical_impact_pct{token, date, window}  # J-30/J/J+30 returns
ocb_unlock_source_freshness_seconds
ocb_unlock_scrape_errors_total
```

**Backfill** : 200 unlocks ≈ 400 reqs total (1 vesting + 1 price chart par event). Faisable en 1 batch initial.

---

### Bench № 023 — Stablecoin Issuer Transparency Score *(P3, PARTIAL)*

**Question** : score multi-critère par issuer (freshness attestations, composition réserves, peg deviation under stress, mint/redeem latency, concentration holders).

**Matrice sources** :

| Issuer | Source | Format | Fréquence | Reproductibilité |
|---|---|---|---|---|
| USDC (Circle) | `circle.com/transparency` + DeFiLlama | HTML dashboard + PDF Deloitte | Mensuel | 🟢 HIGH |
| DAI/USDS (Sky) | On-chain Maker vaults + makerburn + DeFiLlama | JSON + RPC | Real-time | 🟢 HIGH |
| PYUSD (Paxos) | `paxos.com/pyusd-transparency` | PDF KPMG | Mensuel T+5bd | 🟡 MEDIUM (URL prévisible) |
| USDe (Ethena) | `app.ethena.fi/dashboards/transparency` + Dune | JS-rendered + custodian attestations | Real-time on-chain + monthly | 🟡 MEDIUM |
| USDT (Tether) | `tether.to/en/transparency` | SPA (curl renvoie shell) + PDF trimestriel | Trimestriel | 🔴 LOW |
| FDUSD (First Digital) | `firstdigitallabs.com/en/transparency` | 403 sur curl direct (Cloudflare) + PDF | Mensuel | 🔴 LOW |

**Scope v1 — 4 issuers clean** : USDC, DAI/USDS, PYUSD, USDe → full 5-criteria score.

**v2 — Couverture USDT/FDUSD** : worker PDF dédié (`pdftotext` + regex par template), métrique `transparency_lag_days` only au début.

**Métriques Prom** :
```
ocb_stablecoin_attestation_freshness_days{issuer}
ocb_stablecoin_reserve_composition_pct{issuer, category}  # cash | treasury | rwa | crypto
ocb_stablecoin_top10_concentration_pct{issuer}
ocb_stablecoin_transparency_score{issuer}
```

---

### Bench № 024 — Bridge Flow Anomaly *(P2, PARTIAL)*

**Source primaire retenue** : **Wormhole Scan** (free, sans clé)
```
GET https://api.wormholescan.io/api/v1/x-chain-activity/tops
  ?timespan={1h|1d|1mo}&from={ISO}&to={ISO}
  &sourceChain={id}&targetChain={id}
```

**Source écartée** : DeFiLlama bridges → tous les endpoints `/bridges/*`, `/bridgevolume/*`, `/netflow/*` renvoient 402 (plan free supprimé). Aussi : Socket (401), LayerZero stats (DNS down), deBridge (404).

**Couverture v1 — 8 paires Wormhole** :
1. ETH ↔ Solana
2. ETH ↔ Base
3. ETH ↔ Arbitrum
4. ETH ↔ BSC
5. ETH ↔ Polygon
6. ETH ↔ HyperEVM
7. Solana ↔ Base
8. Solana ↔ Arbitrum

**Couverture v2** : canonical bridges L1↔L2 (Arbitrum Inbox, OP Portal, Base Portal) via scraping RPC direct → 10× plus de code mais nécessaire pour couvrir le flux non-Wormhole.

**Anomaly detection** : z-score >3 sur fenêtre glissante 12 semaines (2016 points hourly). Trigger news.

**Métriques Prom** :
```
ocb_bridge_volume_usd{src_chain, dst_chain, window}
ocb_bridge_flow_zscore{src_chain, dst_chain}
ocb_bridge_anomaly_flag{src_chain, dst_chain}
```

---

### Bench № 025 — Oracle Deviation *(P1, GREEN)*

**Extension du bench existant `chainlink-pricefeed`.**

**4 oracles v1, tous free sans clé** :

| Oracle | Endpoint | Latence |
|---|---|---|
| Chainlink | RPC reads (existant) | varies |
| Pyth | `hermes.pyth.network/api/latest_price_feeds?ids[]=<id>` | ~200ms, ~30 req/s soft |
| Binance | `api.binance.com/api/v3/ticker/price` | 1200 req/min IP |
| Coinbase | `api.exchange.coinbase.com/products/<p>/ticker` | 10 req/s public |

**Reporter v2** :
- Redstone — endpoints répondent mais payload signé long (~2KB/symbole, overhead réseau pour 30 paires × 30s)
- Uniswap v3 TWAP — `observe()` (pas `slot0`), decoder tick cumulatives, sqrtPriceX96 → prix décimal-aware, 2-hop via WETH/USDC pour tokens non-USD. Recommandé Alchemy/Infura free tier ou multi-RPC failover (publicnode flaky).

**10 paires v1** : BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, MATIC (toutes /USD).

**Métriques Prom** :
```
ocb_oracle_price{source, pair}
ocb_oracle_deviation_pct{pair, source_a, source_b}
ocb_oracle_update_latency_seconds{source, pair}
```

---

### Bench № 026 — Validator Economics Net of MEV *(P1, GREEN SOL+HL / PARTIAL ETH)*

**Question** : pour ETH / SOL / HL, classer validators sur `yield_net = consensus + execution_tips + MEV − slashing − downtime`.

**Verdict par chain** :

| Chain | Yield brut | MEV captured | Downtime/Slashing | Verdict |
|---|---|---|---|---|
| **Solana** | 🟢 | 🟢 | 🟢 | **GREEN** |
| **Hyperliquid** | 🟢 | N/A (séquenceur centralisé, pas de MEV séparé) | 🟢 | **GREEN** |
| **Ethereum** | 🟡 | 🟢 | 🟡 | **PARTIAL** |

**Sources confirmées free sans clé** :
- **Solana** :
  - `api.stakewiz.com/validators` — APY total, staking_apy, jito_apy, commission, uptime, skip_rate, is_jito → 1 call = tous les validators
  - `kobe.mainnet.jito.network/api/v1/validators` — mev_commission_bps, mev_rewards, priority_fee_rewards, active_stake
- **Hyperliquid** : `api.hyperliquid.xyz/info` type `validatorSummaries` — predictedApr day/week/month, uptimeFraction, isJailed, commission, stake
- **Ethereum (MEV-Boost)** : `boost-relay.flashbots.net/relay/v1/data/bidtraces/proposer_payload_delivered` + ~10 relays publics (ultrasound, agnostic, bloxroute) — même spec API. Mapping `proposer_pubkey → validator_index` via public beacon endpoint (`beaconstate.info`, `publicnode.com`) pour top-N.

**Sources cassées / payantes** :
- Beaconcha.in — 401 sans clé (free tier 10 req/min insuffisant pour 1M validators)
- Rated Network — 401, fully gated depuis Q1 2026
- Relayscan.io API — 404 (UI-only)
- mevboost.pics — redirige vers 404

**Scope v1** :
1. **Solana** (Stakewiz + Jito Kobe — full coverage)
2. **Hyperliquid** (~20 validators actifs, 1 endpoint)
3. **Ethereum top-100 proposers récents** (filtrer aux validators ayant proposé un bloc dans les 7 derniers jours via relay logs → réduit 1M → top-100 par stake/entity, évite besoin Beaconcha.in payant)

**Métriques Prom** :
```
ocb_validator_net_yield_bps{chain, validator}
ocb_validator_uptime{chain, validator}
ocb_validator_mev_share_bps{chain, validator}
ocb_chain_median_net_yield_bps{chain}  # gauge pour alerte seuil
```

---

## 4. Couche transversale — "Make Data Talk"

Indépendante des benches, à factoriser une fois :

### 4.1 Threshold engine
Chaque métrique a un seuil (config YAML), franchissement → event posté sur un bus interne. 1 fichier, 1 mécanisme.

```yaml
# thresholds/buyback.yml
- metric: ocb_buyback_ratio
  protocol: hyperliquid
  threshold: 0.80
  direction: below
  severity: warning
  message: "Hyperliquid buyback ratio drops below 80% of promise"
```

### 4.2 News events API
```
GET /v1/events?since=<ts>&severity=<warning|critical>
```
Consommable par éditorial France Cryptos ou par un bot.

### 4.3 Agent subscription (Telegram)
```
POST /v1/agent/subscribe
  { wallet, assets[], thresholds[], delivery: { kind: telegram, chat_id } }
```
**C'est la différenciation vs DeFiLlama AI / SurfAI** : eux répondent à des questions, OCB *réveille* l'utilisateur sur sa watchlist.

### 4.4 Chart export shareable
SVG/PNG endpoint avec logo center + toggle bar/line/area. 1 endpoint réutilisable par toutes les bench pages, plus simple que 1 composant React par bench.

---

## 5. Roadmap d'exécution

### Sprint 1 (3-4 semaines) — 4 benches P1, all free, all clean
- **№ 018** Buyback Execution Audit (Hyperliquid + GMX + Sky)
- **№ 022** Token Unlocks Pressure
- **№ 025** Oracle Deviation (4 oracles × 10 paires)
- **№ 026** Validator Economics — Solana + Hyperliquid d'abord

Narrative éditoriale FC : "qui tient sa promesse", "qui dilue", "quel oracle est cassé", "qui valide bien". 4 angles éditoriaux distincts → 4 articles publiables au lancement.

### Sprint 2 — 2 benches élargissant la couverture
- **№ 020** Perp Funding Spread (4 DEX REST en v1, on-chain en v2)
- **№ 024** Bridge Flow Anomaly (Wormhole en v1, canonical L2 en v2)
- **№ 026** Ethereum top-100 proposers (extension du bench 026 SOL/HL)

### Sprint 3 — 2 benches avec caveats méthodo
- **№ 017** Real Earnings (avec proxy emissions schedule + disclaimer)
- **№ 023** Stablecoin Transparency (4 issuers clean : USDC + DAI + PYUSD + USDe)

### Reporter / décisions business
- **№ 019** Sustainable DAU — sans budget Dune/Flipside payant ou ETL custom, ne pas shipper. Risque de décrédibiliser OCB avec heuristiques de surface.
- **№ 021** BTC On-Chain full (SOPR/MVRV/NUPL) — décision : budget ~50€/mo Hetzner pour nœud BTC + electrs ? Si oui, sprint 4. Sinon, ship version light "Mining & Cycle" en sprint 3.

---

## 6. Patterns transversaux observés

1. **L'API DeFiLlama free se réduit** : `/emissions` et `/bridges` sont passés 402. À surveiller : `/fees` et `/revenue` toujours free aujourd'hui mais pas garanti. → caching agressif + plan B systématique par bench.
2. **Etherscan V2 unifié** (1 clé free, 5 req/s, 100k/jour, multi-chain ETH+Arb+Base+OP+...) = couvre Maker/GMX/Aave en une clé. À mutualiser.
3. **CryptoRank Next.js data routes** = gold mine pour unlocks/vesting, mais hors API officielle → fragile, monitorer schema drift.
4. **Stable backbone OCB (5 APIs)** sans clé, sans rate-limit sérieux à privilégier :
   - Hyperliquid Info API
   - Wormhole Scan
   - Stakewiz + Jito Kobe (Solana validators)
   - Pyth Hermes
   - DeFiLlama coins (prix historique)

---

## 7. Décisions ouvertes (à trancher avant Sprint 1)

- [ ] Budget Hetzner ~50€/mo pour nœud BTC complet (débloque bench 021 v2 : SOPR/MVRV/NUPL) ?
- [ ] Bench 019 Sustainable DAU : ship version light avec disclaimer fort, ou reporter complètement ?
- [ ] Quel host pour les 4 nouveaux harness P1 ? Railway Mobula comme les autres ?
- [ ] Threshold engine + News API + TG agent endpoint : projet OCB-core ou repo séparé `ocb-events` ?
