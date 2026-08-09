# `/apps` — Addendum aux décisions ouvertes

**Date : 9 août 2026.** Ce document tranche les trois points laissés ouverts dans
`00-EXECUTION-BRIEF.md` et corrige un passage approximatif sur le budget de recompute.

---

## Décision 1 — Renommage de la colonne de classement

`net_real_revenue` est un abus de langage dès qu'on y inclut des buybacks : ce n'est pas
du revenue au sens comptable. Le terme induit le même péché de fusion que DefiLlama.

**Décision** : la colonne de classement s'appelle `net_value_capture_usd`, libellé UI
**« Valeur nette captée »**. La formule est affichée **en permanence** sous l'en-tête de
colonne (pas au survol) :

```
Valeur nette captée
= trésor + holders + burn − émissions
```

La barre segmentée décompose visuellement les trois termes positifs. Le chiffre scalaire
reste disponible pour le tri mais n'est jamais présenté sans sa formule.

**Cohérence avec P4** : `with_holders` est le défaut. `treasury_only` est disponible en
toggle discret. Les deux variantes sont calculées et stockées dans `fee_facts_windowed`
sous `variant IN ('with_holders', 'treasury_only')`.

---

## Décision 2 — Budget de recompute : critère chiffré

La formulation « c'est un simple GROUP BY, ça tient en 30 minutes » était paresseuse. Le
vrai goulot d'étranglement est la jointure de pricing sur `(token, hour)`.

**Analyse** :

- Seules les paires `(token, heure)` où un event a eu lieu sont pricées : la table de
  prix est **creuse et pilotée par la demande**, pas dense.
- Les prix sont une observation (pas un artefact de méthodologie) : un recompute de
  formule ne les invalide pas. Seul un changement de méthode de pricing le fait, et c'est
  rare.
- Le long tail Solana (memecoins) tombe en `pool_ratio`, dérivé du swap lui-même. Ce sont
  les cas les moins chers : aucun appel externe. Seuls ~50 tokens majeurs touchent Pyth.

**Critère d'acceptation chiffré (Phase 1)** :

```
Benchmark sur 20M d'events synthétiques, 3 000 tokens distincts :
- Recompute complet < 30 minutes sur le VPS (4 cores, 15GB RAM)
- EXPLAIN ANALYZE ne montre aucun Seq Scan sur fee_events ou fee_facts
- Si ces deux conditions ne sont pas satisfaites simultanément :
  partitionner fee_events par mois (PARTITION BY RANGE sur ts)
  et fee_facts par (bucket_start, methodology_version)
```

Le partitionnement n'est pas activé par défaut : il complique le schéma sans bénéfice
prouvé à l'échelle MVP. Le benchmark tranche, pas le raisonnement.

---

## Décision 3 — Aerodrome en T1, phase 4a

**Constat** : indexer les swaps Aerodrome en direct getLogs est intenable (milliers de
pools × millions de swaps). Mais on n'a pas besoin des swaps.

Les fees d'Aerodrome atterrissent dans les contrats `FeesVotingReward` (un par gauge),
via `notifyRewardAmount()` appelé par le Voter. L'event émis est :

```solidity
// IReward.sol — vérifié sur aerodrome-finance/contracts main
event NotifyReward(
  address indexed from,    // Voter
  address indexed reward,  // token de fee (USDC, WETH, etc.)
  uint256 indexed epoch,   // epochStart en secondes
  uint256 amount           // montant en unités natives
);

// topic0 vérifié :
// 0x52977ea98a2220a03ee9ba5cb003ada08d394ea10155483c95dc2dc77a7eb24b
```

Volume réel : O(epoch × gauges actives × tokens) — quelques centaines d'events par
semaine, pas un par swap. **Aerodrome est indexable en T1 sans Envio.**

**Prix à payer documenté** : granularité epoch (hebdomadaire). La fenêtre 24h d'Aerodrome
est de résolution dégradée — l'émission AERO est répartie uniformément sur 7 jours
(cf. `aerodrome.yaml : spread_over_epoch: true`) mais les fees sont discrets. L'UI affiche
un badge « résolution hebdomadaire » sur la ligne Aerodrome pour les fenêtres 24h et 7j.
La fenêtre 30j est pleine résolution.

**Comment découvrir les FeesVotingReward** : via `Voter.gaugeToFees(gaugeAddress)`.
Énumérer les gauges actifs depuis `Voter`, résoudre leur contrat de fees à l'init,
surveiller les nouveaux gauges à chaque epoch.

**Aerodrome passe de Phase 4 à Phase 4a** (parallèle à Uniswap, avant Raydium qui reste
le plus complexe).

---

## Correction — passage approximatif dans 01-architecture.md

Le §7 (séquencement) listait Raydium avant Uniswap. Ordre corrigé :

| Phase | Contenu |
|---|---|
| 1 | Socle + dYdX |
| 2 | Hyperliquid + GMX V2 |
| 3 | Page `/apps` + API publique (3 protocoles) |
| 4a | Aerodrome (T1 via NotifyReward) + Uniswap |
| 4b | Raydium (le plus complexe : accrual Solana) |
| 5 | Changelog, exports CSV, coverage page |
