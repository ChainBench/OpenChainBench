# Solana TX Landing Bench - Launch Plan (V0-Lean)

> **Direction validée 2026-05-21.** On lance V0-Lean : 5 services × 1 région × cadence 1 h, **$159/mo** à SOL=$86.20. Escalade par triggers explicites (voir §7).

Compagnon : [`solana-landing-cost-model.md`](./solana-landing-cost-model.md) pour les calculs détaillés.

---

## 1. Les 5 services qu'on probe (V0-Lean)

| # | Service | Tip floor (lamports) | Coût / probe | Rôle dans le bench |
|---|---|---:|---:|---|
| 1 | **Jito Block Engine** | 10 000 | $0.0015 | Baseline + *control probe* pour Helius/Nozomi/Astralane (fan-out) |
| 2 | **Helius Sender** | 10 000 (`swqos_only=true`) | $0.0015 | Le plus utilisé, anycast + 7 POPs |
| 3 | **Astralane Iris** | 500 000 (net refunds) | $0.0437 | Angle unique : tip refunds |
| 4 | **Nozomi (Temporal Labs)** | 1 000 000 | $0.0868 | Premium tier, **sponsor cible #1 (contact direct Florent)** |
| 5 | **0slot.trade** | 1 000 000 | $0.0868 | Premium tier, anti-MEV + durable-nonce |

*Coût par probe = 5 000 base + 2 500 priority + tip floor lamports, converti à SOL=$86.20.*

**Pas dans V0-Lean (réservés V1+) :** bloXroute, NextBlock, SolanaVibeStation - tous demandent un onboarding manuel (sales call, form, paid plan) qui ralentirait le launch. On les ajoute quand le 1er sponsor est signé.

---

## 2. Architecture

```
                       ┌────────────────────────────────┐
                       │  Railway us-east               │
                       │  Service: solana-tx-landing-us │
                       │  Keypair: 1 SOL (~$86)         │
                       │  Auto-topup alert si < 0.3 SOL │
                       └────────────────┬───────────────┘
                                        │ toutes les 60 min
                                        ▼
                       ┌─────────────────────────────────┐
                       │  Probe cycle (PARALLELE)        │
                       │  5 tx signées simultanément     │
                       │  Payload: self-transfer + memo  │
                       └───┬────┬────┬────┬────┬─────────┘
                           │    │    │    │    │
                           ▼    ▼    ▼    ▼    ▼
                         Jito  Helius Astralane Nozomi 0slot
                          │     │      │         │     │
                          │     │ (1) mode swqos_only  │
                          │     │ (2) mode default     │
                          ▼     ▼      ▼         ▼     ▼
                         ════════ Solana mainnet ════════
                                        │
                                        ▼
                       getSignatureStatuses() poll 1s, timeout 60s
                                        │
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ Prometheus :2112                    │
                       │ solana_landing_probe_success_total    │
                       │ solana_landing_probe_latency_slots    │
                       │ solana_landing_probe_latency_ms       │
                       │ solana_landing_probe_dropped_total    │
                       │ labels: service, mode, region       │
                       └─────────────────┬───────────────────┘
                                         ▼
                  prometheus-production-0859.up.railway.app
                  (scrape par le Prom partagé OCB déjà déployé)
                                         ▼
                  openchainbench.com /benchmarks/solana-tx-landing
                  ┌─────────────────────────────────────────────┐
                  │ Tab 1 - Market Share (observationnel,       │
                  │         garde la logique tip-wallet existante)│
                  │ Tab 2 - Landing Latency (NEW, active probe) │
                  │   • Leaderboard hebdomadaire                │
                  │   • p50 / p99 par service                   │
                  │   • Histogram time-to-land                  │
                  └─────────────────────────────────────────────┘
```

---

## 3. Maths du coût

```
  Services        : 5
  Région          : 1 (us-east)
  Cadence         : 1 cycle / heure
  Probes / jour   : 5 × 24 = 120
  Cycles / mois   : 24 × 30 = 720

  Coût par cycle (5 probes en parallèle) :
    Jito           $0.0015
    Helius         $0.0015
    Astralane      $0.0437
    Nozomi         $0.0868
    0slot          $0.0868
                   ───────
    TOTAL / cycle  $0.2204

  Mensuel         : 720 × $0.2204 = $158.73/mo
```

**Ventilation par service :**

| Service | $/mo | % du budget |
|---|---:|---:|
| Nozomi | $62.53 | 39.4% ████████ |
| 0slot | $62.53 | 39.4% ████████ |
| Astralane | $31.50 | 19.8% ████ |
| Helius | $1.09 | 0.7% |
| Jito | $1.09 | 0.7% |
| **Total** | **$158.73** | 100% |

→ **3 services premium = 98.6% du budget.** C'est là qu'il faut négocier des SOL credits sponsor.

---

## 4. Le levier sponsor - SOL credits, pas cash

Au lieu de demander du cash à Nozomi :
- **Ask :** "Vous payez vos propres frais d'évaluation. ~8 SOL / trimestre couvre votre slot Nozomi dans le bench."
- **C'est plus naturel** qu'un sponsor cash : ils financent leur propre mesure (pas le bench global).
- **Effet sur l'économie OCB :**

| Scenario sponsor | OCB net $/mo |
|---|---:|
| Aucun sponsor | $158.73 |
| Nozomi paye ses probes en SOL | $96.20 |
| Nozomi + 0slot payent leurs probes | **$33.66** |
| Nozomi + 0slot + Astralane | $2.18 |

Astralane n'est probablement pas un bon premier ask (plus petit acteur), mais Nozomi + 0slot c'est jouable.

---

## 5. Méthodologie - ce qu'on mesure, comment

### Probe payload
Self-transfer de 1 lamport + Memo program (8 octets aléatoires). ~5 000 lamports de frais base. Pas de mutation de state extérieur, pas de risque de perte.

### Le Jito control probe
Helius (mode default), Nozomi, Astralane font tous du fan-out vers Jito en interne. Sans contrôle, on ne sait pas si "Nozomi a landé" ou "Jito a landé pour le compte de Nozomi".

**Solution :** Jito est probé *en même cycle* que les autres → comparaison slot-par-slot dans la même fenêtre de congestion. Si Nozomi land au même slot que Jito → routing Jito. Si Nozomi land 2 slots plus tôt → vraie valeur ajoutée Nozomi.

### Helius double-mode
On probe Helius en 2 modes :
1. `?swqos_only=true` → isole le path Helius pur (sans fan-out Jito)
2. mode par défaut → Helius + Jito fan-out

→ 2 séries Prom : `mode="swqos_only"` et `mode="dual"`. Coût supplémentaire : +$1/mo.

### Définition "landed"
- Confirmation level : `confirmed` (1+ block).
- Timeout : 60s. Au-delà → classified `dropped` avec `reason=timeout`.
- Métriques : `slot_delta = land_slot - submit_slot` (resolution slot) + `wall_clock_ms` (resolution ms).

### Statistical power à cette cadence

| Période | Probes / service | Ce qu'on peut claim |
|---|---:|---|
| 1 jour | 24 | p50 stable, p99 bruité |
| 1 semaine | 168 | p50 + p99 stables, gaps 5pp détectables |
| 2 semaines | 336 | gaps 3pp détectables |

→ **Rythme de publication recommandé : hebdomadaire.** Article + leaderboard refresh chaque lundi matin.

---

## 6. Garanties méthodologie (sponsor-proof)

Bake-in dès le launch - ajouter après coup donne l'air défensif.

1. **Méthodo pré-enregistrée sur GitHub** avant tout contrat sponsor. Changements via PR public + fenêtre commentaire 14 jours.
2. **Inclusion automatique** dès qu'un endpoint est publiquement reachable. Les sponsors n'entrent pas dans le leaderboard via cash.
3. **Harness open-source** dans ce repo (`harnesses/solana-tx-landing/`).
4. **Paramètres probe identiques** entre services. Toute déviation per-service (auth méthode, endpoint) → footnote sur la row.
5. **Clause non-suppression dans le contrat sponsor.** Seul recours sponsor pour résultat défavorable = terminer + refund pro-rata. Jamais d'édit.
6. **Funding itemisé publiquement** par trimestre, tier S/M/L à la L2Beat.
7. **Pas d'accès en avance aux résultats.** Sponsors voient les chiffres en même temps que le public.

**Disclosure block** (72 mots, à mettre dans le champ `sponsorship` du spec YAML) :

> OCB measures every reachable Solana transaction-landing service on identical probe parameters. The harness is open-source and re-runnable by anyone. Sponsors fund OCB's operations and receive newsletter visibility, case studies, and integration support - never leaderboard influence, advance results, or methodology changes. Current sponsors : see /funding (updated quarterly). Sponsor contracts include a non-suppression clause : OCB publishes unfavorable results without exception. Disputes go through public GitHub issues.

---

## 7. Échelle de tiers (escalade par triggers)

```
START ──► V0-Lean  $159/mo
            │   5 svc × 1 reg × 60min
            │   Refresh hebdomadaire
            │
            ├──► +Cadence       ($318/mo)  ─── Si on veut leaderboard quotidien
            │    5 svc × 1 reg × 30 min
            │
            ├──► +Couverture    ($580/mo)  ─── Quand 1er sponsor signe
            │    8 svc × 1 reg × 30 min
            │    (ajoute bloXroute, NextBlock, SVS)
            │
            └──► +Géo edge      ($1 743/mo) ── Quand 2-3 sponsors OU
                 8 svc × 3 reg × 30 min        sponsor demande story géo
```

**Triggers explicites :**

| Trigger | Action |
|---|---|
| 4 semaines de data publiée et la narrative demande de la fraîcheur quotidienne | V0-Lean → V0-Daily ($318) |
| 1 sponsor signe ($500+/mo cash OU SOL credits couvrant ≥1 service premium) | V0-Daily → V1 ($580) |
| 2-3 sponsors signés OU 1 sponsor demande spécifiquement la story "geographic edge" | V1 → V2 ($1 743) |
| SOL passe au-dessus de $200 | Recompute tout, peut imposer un downgrade temporaire |

**Anti-pattern :** sauter à V2 avant signature sponsor = brûler $1.7k/mo pour répondre à une question (geographic edge) que personne n'a posée publiquement.

---

## 8. Roadmap d'implémentation

### Étape 1 - mobula-api (refactor harness)

Fichiers à toucher dans `miniapps/solana-tx-landing/cmd/script/` :

```
  main.go        - fork en 2 goroutines: runSubscriber() (obs) + runProber() (actif)
  prober.go      - NEW. Boucle 1 cycle/h, fire les 5 services en parallèle
  active_metrics.go  - NEW. Définitions Prom solana_landing_probe_*
  config.go      - env vars: SOLANA_LANDING_SERVICES, _CADENCE, _RPC_URL, etc.
  subscriber.go  - UNCHANGED (la logique observationnelle reste)
  wallets.go     - UNCHANGED (tip wallets pour l'attribution Market Share)
```

### Étape 2 - mobula-api (infra)

- Générer 1 keypair Solana, le funder de 1 SOL (~$86) via wallet perso, store en Railway Env Secret `SOLANA_PROBE_KEYPAIR`.
- Renommer le service Railway existant `solana-tx-landing` → `solana-tx-landing-us` pour cohérence future multi-région (geste de cleanup, ne change rien à l'usage actuel).
- Ajouter scrape target dans `miniapps/openchainbench-monitoring/prometheus/prometheus.yml` : pointer vers `solana-tx-landing-us.railway.internal:2112` (le service est déjà scraped en V0 - vérifier le job_name).

### Étape 3 - OpenChainBench (spec + UI)

```
  benchmarks/solana-tx-landing.yml
    - Garder le contenu existant (Market Share)
    - Ajouter section "Landing Latency" avec métriques solana_landing_probe_*
    - Ajouter champ `sponsorship` avec le disclosure block du §6
    - Mettre à jour `disclaimer` pour mentionner les 2 facettes
  docs/methodology/solana-tx-landing-active.md
    - NEW. Méthodo pré-enregistrée (les 7 règles du §6 + détails probe)
    - Commit AVANT toute conversation contractuelle sponsor
  src/lib/spec.ts
    - Vérifier qu'il supporte un schema 2-tabs (Market Share + Latency)
    - Sinon : étendre minimal le loader
```

### Étape 4 - Sponsor outreach

1. **Nozomi en premier** (contact direct Florent). Pitch : 8 SOL / trimestre = leur slot Nozomi dans le bench. Featured tier dans `/funding`.
2. **0slot ensuite** (Discord `kurt0slot` ou TG `@kurt0slot`). Même ask.
3. Si les 2 signent → OCB net mensuel ≈ $34. Le bench se finance.

### Étape 5 - Aller live

- Méthodo committée sur GitHub.
- 4 semaines de data accumulée en privé (pour valider le pipeline + détecter les bugs).
- Annonce publique avec article France Cryptos + cross-post X.

---

## 9. Décisions encore ouvertes (à valider par Florent)

| # | Question | Reco |
|---|---|---|
| 1 | Disclose aux providers qu'on les probe ? | **Oui**, top-3 (Jito, Helius, Nozomi) avant launch |
| 2 | Helius en double-mode (swqos_only + default) ? | **Oui**, coût négligeable |
| 3 | Ask Nozomi : flat fee cash ou SOL credits ? | **SOL credits** - plus naturel |
| 4 | Garder le tab observational (Market Share) ? | **Oui**, 1 page 2 tabs |
| 5 | Renommer service Railway de `solana-tx-landing` → `solana-tx-landing-us` ? | **Oui**, cleanup pour cohérence future |

---

## 10. Ce qui n'est PAS dans ce plan

- **Code Go** - pas écrit tant que décisions §9 pas validées.
- **YAML du spec OCB** - pas modifié avant méthodo committée sur GitHub (cf §6.1).
- **Contrat sponsor type** - étape légale séparée, hors scope ingénieur.
- **bloXroute, NextBlock, SVS** - reportés V1+, on les onboard quand le pipeline V0-Lean tourne.
- **Multi-région** - reporté V2, on lance us-east only.

---

**Last updated :** 2026-05-21. Recompute toutes les valeurs $ si SOL bouge de ±30%.
