# Solana TX Landing — Deployment Checklist (V0-Lean)

> Liste exhaustive de ce dont tu as besoin pour passer du code committé à un bench actif en prod. Ordre conseillé : lis tout, puis suis les étapes 1 → 8.

---

## 0. État actuel — ce qui est déjà fait

✅ Code écrit, compile, vet propre. 4 fichiers dans `mobula-api/miniapps/solana-tx-landing/cmd/script/` :
- `prober.go` (NEW) — boucle de probe, build/sign tx, polling
- `senders.go` (NEW) — HTTP par service (Jito, Helius, Nozomi, Astralane, 0slot)
- `active_metrics.go` (NEW) — métriques Prom
- `main.go` (EDITED) — lance la goroutine prober en plus du subscriber

✅ Méthodologie pré-enregistrée dans `OpenChainBench/docs/methodology/solana-tx-landing-active.md`

✅ Le prober est **opt-in** : si `SOLANA_PROBE_KEYPAIR_BASE58` n'est pas set, il logge `[prober] disabled: ...` et le bench reste en mode observationnel pur. Donc déployer le code sans configurer les secrets ne casse rien.

---

## 1. Générer + funder le keypair Solana

```bash
# Sur ta machine locale (PAS sur Railway — la clé privée ne doit jamais
# transiter par git ou stdout sur un serveur)
solana-keygen new --no-bip39-passphrase -o ~/probe-keypair-us-east.json

# Note l'adresse publique
solana address -k ~/probe-keypair-us-east.json

# Récupère la base58 de la clé privée (à mettre en env var Railway)
# Le fichier JSON contient un tableau de 64 bytes ; on peut le convertir :
node -e "console.log(require('bs58').encode(Buffer.from(JSON.parse(require('fs').readFileSync(process.env.HOME+'/probe-keypair-us-east.json')))))"
# OU avec Python:
# python3 -c "import json, base58; print(base58.b58encode(bytes(json.load(open('/Users/user/probe-keypair-us-east.json')))).decode())"
```

**Funder le keypair** : envoie ~1 SOL (~$86) sur l'adresse publique depuis ton wallet perso. À V0-Lean cadence (1/h, 5 services), 1 SOL dure ~2 mois. Le bench logge un warning quand le balance passe sous 0.3 SOL.

⚠️ **Stocke le fichier `probe-keypair-us-east.json` quelque part de safe** (1Password / coffre Mobula). Si tu le perds, les fonds restent récupérables via la base58 que tu auras mise en Railway — mais inversement, si Railway leak la base58, anyone peut vider le wallet. Le risque est limité à 1 SOL.

---

## 2. Apply pour les API keys

| Service | Comment apply | Délai estimé | Notes |
|---|---|---|---|
| **Nozomi** | Contact direct (Florent → Temporal Labs) + form `temporal.xyz` | Quelques jours (contact direct accélère) | Pitch : OCB bench, paie ses propres probes en SOL credits |
| **Astralane** | Form sur `astralane.io` | Variable | Plans flexibles, no public price |
| **0slot.trade** | Discord `kurt0slot` ou Telegram `@kurt0slot` | Rapide (manuel) | Première semaine gratuite, puis Trial/Entry/Intermediate/Advanced tier |
| **Jito UUID** *(optional)* | Ticket via `discord.gg/jito` | Variable | Augmente le rate limit au-delà des 1 req/s par IP |

**Si une clé n'est pas obtenue**, le service est simplement skippé au launch (log `[prober] <service>: <ENV_VAR> not set — service skipped`). Le bench tourne avec les services restants. Tu peux ajouter les services au fur et à mesure.

**Reco order** : Nozomi → 0slot → Astralane → Jito UUID. Les 2 premiers sont les plus impactants pour la cardinalité du bench.

---

## 3. Setup les env vars Railway

Service Railway : **`solana-tx-landing`** (existing — pas besoin de créer un nouveau service en V0-Lean ; on déploie le code sur le service existant qui devient hybride observational + active).

| Env var | Required? | Valeur | Notes |
|---|---|---|---|
| `SOLANA_PROBE_KEYPAIR_BASE58` | **OUI** (active le prober) | base58 du keypair généré en §1 | Sans ça, prober disabled |
| `SOLANA_PROBE_REGION` | non (def: `us-east`) | `us-east` | Label Prom |
| `SOLANA_PROBE_INTERVAL` | non (def: `1h`) | `1h` pour V0-Lean | Go duration : `30m`, `15m`, etc. pour escalader |
| `SOLANA_PROBE_RPC_URL` | non | `https://api.mainnet-beta.solana.com` | RPC public mainnet pour les reads (getSlot, getSignatureStatuses, getBalance) |
| `SOLANA_PROBE_SERVICES` | non (def: tous) | `jito,helius-sender,nozomi,astralane,0slot` | Liste comma-séparée. Permet de skip explicitement |
| `NOZOMI_API_KEY` | non | clé obtenue en §2 | Skip Nozomi si absent |
| `ASTRALANE_API_KEY` | non | clé obtenue en §2 | Skip Astralane si absent |
| `ZEROSLOT_API_KEY` | non | clé obtenue en §2 | Skip 0slot si absent |
| `JITO_AUTH_UUID` | non | UUID obtenu en §2 | Augmente rate limit Jito |

**Overrides pour le tip floor** (rarement utiles, mais possibles) :
- `JITO_TIP_LAMPORTS` (def 10_000)
- `HELIUS_TIP_LAMPORTS` (def 10_000)
- `NOZOMI_TIP_LAMPORTS` (def 1_000_000)
- `ASTRALANE_TIP_LAMPORTS` (def 500_000)
- `ZEROSLOT_TIP_LAMPORTS` (def 1_000_000)

⚠️ **Tout changement de tip est une modification méthodologique** = PR + 14 jours de comment window selon Rule #1.

**Overrides pour les endpoints** (escape hatch ops si un provider change de host sans préavis) :
- `NOZOMI_ENDPOINT` (def `https://ewr.nozomi.temporal.xyz/`)
- `ASTRALANE_ENDPOINT` (def `https://ny.gateway.astralane.io/iris`)
- `ZEROSLOT_ENDPOINT` (def `https://ny.0slot.trade`)

Pas de override pour Jito ou Helius — leurs hosts sont hardcodés dans `senders.go` (modifier requiert PR méthodologique).

**Métrique opérationnelle additionnelle :** `solana_landing_probe_enabled{region}` (gauge, 0 ou 1) — permet de distinguer sur le dashboard "prober désactivé" (env var pas set) vs "prober planté" (set mais aucune cycle récente).

---

## 4. Setup Prometheus (rien à toucher)

Le service Railway `solana-tx-landing` est déjà scrapé par le Prom partagé OCB sur `:2112/metrics`. Les nouvelles métriques `solana_landing_probe_*` apparaîtront automatiquement dès le premier redeploy. **Pas besoin de modifier `miniapps/openchainbench-monitoring/prometheus/prometheus.yml`.**

Métriques exposées en V0-Lean :
```
solana_landing_probe_success_total{service, mode, region}
solana_landing_probe_dropped_total{service, mode, region, reason}
solana_landing_probe_latency_slots{service, mode, region}
solana_landing_probe_latency_slots_histogram{service, mode, region}
solana_landing_probe_latency_ms{service, mode, region}
solana_landing_probe_latency_ms_histogram{service, mode, region}
solana_landing_probe_keypair_balance_sol{region}
solana_landing_probe_cycle_total{region}
solana_landing_probe_last_cycle_timestamp_seconds{region}
```

Cardinalité totale : ~30 séries. Négligeable pour notre Prom.

---

## 5. Workflow Git pour shipper

Tu es actuellement sur `feat/france-cryptos-sprint1` sur `mobula-api`. **Ne push pas sur `dev`.**

```bash
cd /Users/user/mobula/mobula-api

# Crée une branche dédiée si tu veux isoler le prober du reste du sprint
git checkout -b feat/solana-landing-active-prober

# Lint avant de committer (CLAUDE.md global rule)
bun lint:fix

# Stage uniquement les fichiers du prober
git add miniapps/solana-tx-landing/cmd/script/active_metrics.go \
        miniapps/solana-tx-landing/cmd/script/prober.go \
        miniapps/solana-tx-landing/cmd/script/senders.go \
        miniapps/solana-tx-landing/cmd/script/main.go \
        miniapps/solana-tx-landing/go.mod \
        miniapps/solana-tx-landing/go.sum

git commit -m "solana-tx-landing: add active landing prober (V0-Lean)"
git push -u origin feat/solana-landing-active-prober
```

**Pour OpenChainBench (les docs)** :
```bash
cd /Users/user/mobula/OpenChainBench

git checkout -b feat/solana-landing-active-methodology
git add docs/methodology/solana-tx-landing-active.md \
        docs/solana-landing-tiered-architecture.md \
        docs/solana-landing-cost-model.md \
        docs/solana-landing-active-bench-plan.md \
        docs/solana-landing-deployment-checklist.md

git commit -m "docs: add Solana TX landing active bench plan + methodology"
git push -u origin feat/solana-landing-active-methodology
```

**Liens PR à créer manuellement après push :**
- `mobula-api` → PR vers `dev` (URL générée par GitHub après `git push`)
- `OpenChainBench` → PR vers `main`

⚠️ **Ordre important** : la méthodologie OCB DOIT être mergée AVANT toute conversation sponsor (Rule #1 : pre-registered methodology before any contract).

---

## 6. Première vérification post-déploiement

Une fois Railway redéployé avec `SOLANA_PROBE_KEYPAIR_BASE58` set :

```bash
# Logs Railway — chercher le banner du prober
# Tu devrais voir:
#   [prober] enabled — region=us-east interval=1h0m0s services=N
#   · jito              mode=default       tip=10000 lamports endpoint=https://...
#   · helius-sender     mode=swqos_only    tip=10000 lamports endpoint=http://...
#   · ...

# Après ~5 secondes (le warmup) :
#   [prober] cycle abc123… done in 8.234s
```

Métriques à vérifier dans Prometheus (via Grafana ou query directe) :
```promql
# Probes lancées
sum(rate(solana_landing_probe_cycle_total[1h])) * 3600  
# = doit être ≈ 1.0 (1 cycle par heure)

# Landing rate par service (rolling 7 jours)
sum(rate(solana_landing_probe_success_total[7d])) by (service)
/
(sum(rate(solana_landing_probe_success_total[7d])) by (service) + 
 sum(rate(solana_landing_probe_dropped_total{reason="timeout"}[7d])) by (service))

# Keypair balance (doit décroître lentement)
solana_landing_probe_keypair_balance_sol{region="us-east"}
```

---

## 7. Spec OCB côté site (à faire APRÈS la méthodologie mergée)

Le fichier `OpenChainBench/benchmarks/solana-tx-landing.yml` actuel décrit la version observational uniquement. À étendre :

1. Ajouter une section pour les nouvelles métriques (`solana_landing_probe_*`)
2. Ajouter le champ `sponsorship` avec le disclosure block (cf §6 de tiered-architecture.md)
3. Ajouter une référence vers la méthodologie pré-enregistrée
4. *Optionnel* : étendre `src/lib/spec.ts` pour supporter le rendu 2-tabs (Market Share + Landing Latency) — à voir si nécessaire ou si on rend tout dans une seule page allongée

À faire dans une PR séparée pour découpler infra (mobula-api) et site (OpenChainBench).

---

## 8. Sponsor outreach — DEUX semaines après que la méthodologie soit mergée

| Étape | Action |
|---|---|
| W+0 | Méthodologie publique mergée sur `OpenChainBench/main` |
| W+1 | Bench tourne en prod, première data semaine arrive |
| W+2 | Premier ping Nozomi avec : link méthodologie + first-week data preview + ask SOL credits |
| W+3 | Nozomi → Featured tier ($1.5-2.5k/mo équivalent SOL ou cash). Avec ça V0-Lean → V1 ($580/mo, OCB net ~$300). |
| W+4 | Ping 0slot via Discord. Idem ask. |
| W+8 | Ré-évaluer : si on a 2 sponsors et la story geographic edge demandée → escalade vers V2 (3 régions). |

---

## 9. Décisions encore ouvertes (à toi de trancher)

| # | Décision | Reco par défaut |
|---|---|---|
| A | Disclose à Jito/Helius/Nozomi qu'on les probe ? | **Oui**, avant launch — email courte annonçant le bench public |
| B | Renommer le service Railway `solana-tx-landing` → `-us` pour cohérence multi-région future ? | **Oui**, geste de cleanup |
| C | Si Nozomi répond "non" au sponsoring, on probe quand même ? | **Oui**, méthodologie dit "sponsors ne contrôlent pas l'inclusion" |
| D | Configurer un alert Slack sur `solana_landing_probe_keypair_balance_sol < 0.3` ? | **Oui**, sinon on rate des cycles silencieusement |
| E | Activer Helius en dual-mode (en plus de swqos_only) ? | **Pas en V0-Lean.** Méthodologie figée. À reconsidérer en v1.0.1 PR |

---

## Annexe — Que faire si quelque chose plante

| Symptôme | Cause probable | Fix |
|---|---|---|
| `[prober] disabled: SOLANA_PROBE_KEYPAIR_BASE58 not set` | Env var pas configurée | Set dans Railway settings |
| `[prober] disabled: decode keypair: invalid base58` | Mauvais encoding du keypair | Re-run la commande de §1 |
| `[prober] disabled: no services configured` | Aucune clé sponsor + `SOLANA_PROBE_SERVICES` mal écrit | Vérifier que Jito + Helius (sans clé) sont au moins là |
| `[prober][nozomi] submit: rpc error -32xxx` | Clé invalide ou expirée | Re-issue avec Temporal |
| `[prober][...] submit: http: dial tcp ... no such host` | DNS Railway / endpoint typo | Vérifier l'endpoint dans senders.go |
| Keypair balance ne décroît pas | Service `solana-tx-landing` n'a pas le keypair env | Vérifier les secrets Railway |
| Balance décroît plus vite que prévu | Tip floor mal configuré ou cycle interval trop court | Vérifier `SOLANA_PROBE_INTERVAL` et `*_TIP_LAMPORTS` |

---

**Last updated :** 2026-05-21 — V0-Lean (5 services × us-east × 1 h cadence × $159/mo théorique).
