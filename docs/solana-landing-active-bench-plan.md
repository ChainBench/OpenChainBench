# Solana TX Landing — Plan obsolète

> ⚠️ **Ce document est obsolète depuis 2026-05-21.**
>
> Direction validée par Florent : ship **V0-Lean** (5 services × 1 région × 1 / heure × **$159/mo**) au lieu de l'ancien "Phase 0" à 8 services × 3 régions.
>
> Le plan courant est dans [`solana-landing-tiered-architecture.md`](./solana-landing-tiered-architecture.md).
>
> Le cost-model détaillé est dans [`solana-landing-cost-model.md`](./solana-landing-cost-model.md) — note de correction en tête du fichier.

---

## Ce qui a changé

| Avant (ce doc) | Après (tiered-architecture.md) |
|---|---|
| 8 services × 3 régions × 2 min | 5 services × 1 région × 60 min |
| Phase 0 = $1 452/mo (chiffre faux, vrai = $26 k/mo) | V0-Lean = $159/mo (calcul vérifié) |
| Services V0 : Jito + Helius + Nozomi + NextBlock | Services V0-Lean : Jito + Helius + Nozomi + Astralane + 0slot |
| Launch immédiat avec scope complet | Phasage : V0-Lean → V0-Daily → V1 → V2 sur signature sponsor |

## Ce qui reste valide depuis ce doc

- **Le Jito control probe** pour Helius/Nozomi/Astralane fan-out (gardé dans tiered-architecture §5).
- **Les 7 règles méthodologie sponsor-proof** (gardées dans tiered-architecture §6).
- **Le tier ladder Listed / Verified / Featured** pour le sponsoring (gardé).
- **L'ordre d'outreach sponsor** : Nozomi en premier (contact direct), 0slot ensuite via Discord.

## Conservé pour archive

Le contenu original n'est plus à jour mais reflète l'analyse initiale des 4 agents (provider matrix, architecture, cost model, sponsor bias). Si besoin de retrouver les détails par service (bloXroute, NextBlock, SVS qui sont reportés V1+), voir le rapport de l'agent provider matrix dans le transcript de la conversation du 2026-05-21.
