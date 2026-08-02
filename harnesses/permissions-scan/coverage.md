# Coverage Report — Perp DEX Exit Rights Scan

**EVM measured:** 2026-08-02T19:08:53Z — block 490,422,447 (Arbitrum One)  
**Non-EVM measured:** 2026-08-02T21:00:00Z  
**Tooling:** cast (foundry 1.5.1), permission-scanner (deficollective/permission-scanner), L2Beat, Etherscan/Arbiscan API v2, source code review

---

## Statut scanner

Permission-scanner **complété** pour gains, gmx-v2, ostium. Clé Etherscan v2 récupérée depuis le VPS (variable d'environnement conteneur Docker). Scanner lancé via `python3 src/main.py` dans `/tmp/permission-scanner/` avec `contracts.json` de chaque cible.

**Vertex : scanner non lancé** — tous les contrats d'implémentation de Vertex (Endpoint impl, Clearinghouse impl, SpotEngine, PerpEngine, OffchainExchange, Querier) ne sont PAS vérifiés sur Arbiscan. L'API Etherscan v2 retourne "Contract source code not verified" pour toutes ces adresses. Seuls les proxy wrappers (TransparentUpgradeableProxy) sont vérifiés. Le scanner ne peut pas tourner sans code source.

---

## Tableau de couverture

### EVM — Arbitrum One

| Champ | gains | gmx-v2 | ostium | vertex |
|---|---|---|---|---|
| `contracts_list` | ✅ bytecode | ✅ bytecode | ✅ bytecode | ✅ onchain |
| `proxy_impl_resolved` | ✅ EIP-1967 + EIP-2535 | n/a | ✅ oLP + Trading | ✅ Endpoint + CH |
| `upgrade_delay_seconds` | ✅ 14j (onchain) | ✅ 1j (onchain) | ✅ 18h (onchain) | unknown — pas de Timelock |
| `owner_type` | ✅ TimelockController | ✅ GovTimelock + ProtocolGovernor + custom Timelock | ✅ Safe 4/8 → Timelock 18h | ✅ Safe 4/6 via proxy |
| `owner_addresses` | ✅ Safe 4/7 + Safe 2/4 (onchain events) | ✅ TIMELOCK_MULTISIG=Safe 5/8, ADMIN=Safe+2×EOA | ✅ Safe 4/8 owners listés | ✅ Safe 4/6 owners listés |
| `permissions_functions` | ✅ scanner (bytecode) | ✅ scanner (bytecode) | ✅ scanner (bytecode) | unknown — impls non vérifiées |
| `contracts_verified` | ✅ true | ✅ true | ✅ true | ⚠️ partial (proxies seulement) |
| `chain_l2beat_stage` | Stage 1 | Stage 1 | Stage 1 | Stage 1 |
| `lp_exit` | ❌ false — 3 oracle-epochs, maxWithdraw=0 testé | ❌ false — keeper requis | ✅ true — tryNewSettlement() public, max 90j | unknown |
| `trader_exit` | ❌ false — oracle requis | ❌ false — keeper requis | ❌ false — oracle Stork requis | unknown |
| `can_user_exit_unilaterally` | ❌ false | ❌ false | ✅ true (délai, risque gov) | unknown |
| `exit_depends_on` | oracle (epoch callbacks) | keeper CONTROLLER | gov (contrôle interval) | sequencer (bytecode inconnu) |
| `forced_inclusion` | n/a | n/a | n/a | n/a |

### Non-EVM

| Champ | hyperliquid | lighter | aster |
|---|---|---|---|
| `chain` | Custom L1 HyperBFT + ARB bridge | ETH ZK-rollup | Multi-chain (BNB/ETH/ARB/SOL + PoSA) |
| `funds_contract` | ✅ 0x2Df1c5 (ARB, verified) | ✅ 0x3B4D79 (ETH, verified) | documented only (unverified) |
| `contracts_verified` | partial (bridge oui, L1 fermé) | true (+ prover open source) | unknown |
| `l2beat_stage` | "Other" — non-L2 | Stage 0 Appchain | n/a |
| `upgrade_delay_seconds` | 0 — EOA sans timelock (CRITIQUE) | 0 — UpgradeGatekeeper sans délai (CRITIQUE) | unknown |
| `lp_exit` | ❌ false — validateurs requis | documented only | ❌ false — 2/3 validateurs internes |
| `trader_exit` | ❌ false — validateurs requis | ✅ true — Desert Mode 14j | ❌ false — 2/3 validateurs internes |
| `can_user_exit_unilaterally` | ❌ false | ✅ true (14j + ZK proof) | ❌ false |
| `exit_depends_on` | ~27 validateurs + EOA upgrade | séquenceur + UpgradeGatekeeper EOA | 2/3 validateurs internes |
| `forced_inclusion` | none | Desert Mode (14j) | none documenté |
| `tier_confidence` | documented | documented | documented |

---

## Détail par cible

### gains (gTrade)

**Mesuré :**
- GNSMultiCollatDiamond proxy `0xFF162c...` + impl `0xff84c4...` (EIP-1967 + EIP-2535 Diamond)
- ProxyAdmin `0xe18be0...` → owner = GNSTimelockOwner `0x5f5E48...`
- GNSTimelockOwner `getMinDelay()` = 1 209 600 s (14 jours) — confirmé on-chain
- GNSTimelockManager `getMinDelay()` = 259 200 s (3 jours) — confirmé on-chain
- 4 gToken vaults (gDAI, gGNS, gETH, gUSDC) — contrats publics confirmés avec bytecode
- Source officielle : https://docs.gains.trade/what-is-gains-network/contract-addresses/arbitrum-mainnet

**Scanner (complété) :**
- GToken `withdraw()` et `redeem()` : modifier `checks` (gate ERC4626 standard — vérifie les balances, PAS une restriction admin). LP peut retirer directement.
- GToken `mint()` / `burn()` : modifier `onlyOwner` (GNSTimelockOwner = 14 jours). Seul le protocole peut créer/détruire des shares.
- Diamond `diamondCut()` : modifier `onlyRoles(ROLES_MANAGER_ROLE)`. Upgrades de facets contrôlés par rôle.
- `contracts_verified` : true — GNSMultiCollatDiamond proxy (solc 0.8.9), impl (solc 0.8.23), gTokens (solc 0.8.9), timelocks (solc 0.8.17) — tous vérifiés Arbiscan.
- `can_user_exit_unilaterally` : **true** pour les LP (redeem/withdraw directs sur gToken). Traders : oracle requis pour `closeTradeMarket()`.

**Unknown / raisons :**
- `GNSTimelockOwner_proposer` : AccessControl non-enumerable. Résolution nécessite scan d'events `RoleGranted` ou Etherscan.
- `version_confirmed` : EIP-2535 ne stocke pas de version. "v10.3" non confirmable on-chain.
- `alternative_frontend` : non vérifié.

---

### gmx-v2

**Mesuré :**
- 12 contrats depuis `github.com/gmx-io/gmx-synthetics/deployments/arbitrum/` (JSON officiels)
- ExchangeRouter `0x602b805...` confirmé on-chain via `dataStore()` → DataStore address
- GovTimelockController `getMinDelay()` = 86 400 s (1 jour)
- GovTimelockController PROPOSER = ProtocolGovernor (confirmé `hasRole()`)
- GovTimelockController EXECUTOR = ProtocolGovernor (confirmé `hasRole()`)
- ProtocolGovernor : `proposalThreshold()` = 30 000 GovToken, `votingDelay()` = 86 400 blocs
- Custom Timelock delay = 86 400 s (slot de storage 1 = 0x15180)
- Source: `github.com/gmx-io/gmx-synthetics/tree/main/deployments/arbitrum`

**Scanner (complété) :**
- DataStore : 39 fonctions setter toutes gated `onlyController`. Les keepers (bots) détiennent le rôle CONTROLLER dans RoleStore.
- RoleStore : `grantRole`/`revokeRole` gated `onlyRoleAdmin`.
- Custom Timelock : découverte de deux rôles non-standard — `onlyTimelockMultisig` (signalement/propose) et `onlyTimelockAdmin` (exécution/finalisation). Schéma à deux clés.
- `contracts_verified` : true — tous les 12 contrats vérifiés Arbiscan (solc 0.8.18/0.8.20).

**Unknown / raisons :**
- `custom_Timelock_admin` / `custom_Timelock_multisig` : `gov()`, `owner()`, `timelockAdmin()` répondent par revert. Les détenteurs des rôles `onlyTimelockMultisig` et `onlyTimelockAdmin` ne sont pas résolus. Scan d'events ou lecture storage avancée requis.
- `alternative_frontend` : non vérifié.

---

### ostium

**Mesuré :**
- oLP vault proxy `0x20d419...` + impl `0x1E20E4...` (EIP-1967)
- Trading proxy `0x6d0ba1...` + impl `0x8cbb5b...` (EIP-1967)
- ProxyAdmin `0x083f97...` → owner = TimelockOwner `0xeb85dc...` (confirmé on-chain)
- TimelockOwner `getMinDelay()` = 64 800 s (18 heures) — confirmé on-chain
- PROPOSER_ROLE grantee = `0x1cd84f9b...` (Gnosis Safe 4/8, 8 owners listés) — confirmé via events `RoleGranted` + appels `getThreshold()` / `getOwners()`
- EXECUTOR_ROLE grantee = `0x1cd84f9b...` (même Safe) — confirmé via events
- Source adresses : `ostium-labs.gitbook.io/ostium-docs` (deprecated) + Arbiscan labels

**Avertissement source :** Les adresses Ostium viennent de la doc dépréciée + Arbiscan labels, non d'une page de déploiement officielle active. La cohérence a été vérifiée (bytecode présent sur chaque adresse, ProxyAdmin → Timelock chain cohérente). Mais l'absence de source primaire documentée officielle est un risque de qualité.

**Scanner (complété) :**
- OstiumVault : pattern async confirmé — `requestWithdraw(uint256)` → opérateur `settle()` → `claimWithdraw(uint256)`. Le `settle()` a modifier `onlyGov` : sans l'opérateur, les fonds sont bloqués après `requestWithdraw`.
- `pause()`/`unpause()` sur OstiumVault : `onlyGov`. L'opérateur peut geler les retraits.
- OstiumTrading : 22 fonctions `onlyGov` — ouverture/fermeture de positions entièrement contrôlées par gov.
- `contracts_verified` : true — proxies (solc 0.8.9), impls (solc 0.8.24), TimelockOwner (solc 0.8.24) — tous vérifiés.
- `can_user_exit_unilaterally` : **false** — retrait nécessite `settle()` opérateur entre `requestWithdraw` et `claimWithdraw`.

**Unknown / raisons :**
- `PairInfos_impl`, `PairsStorage_impl` : slots impl non lus pour ces deux proxies.
- `alternative_frontend` : non vérifié.

---

### vertex

**Mesuré :**
- Endpoint proxy `0xbbee07...` + impl `0x91ffc8...` (EIP-1967)
- Clearinghouse proxy `0xae1ec2...` + impl `0x63a497...` (EIP-1967)
- SpotEngine, PerpEngine, OffchainExchange, Querier : bytecode présent, non-proxy
- Endpoint `owner()` = `0x2BC1F3...` (proxy lui-même, EIP-1967 impl = `0xb7eb64...`)
- `0x2BC1F3...` `owner()` = `0xC6B129...` (Gnosis Safe 4/6, 6 owners listés)
- `submitSlowModeTransaction()` dans le source GitHub de l'Endpoint : mécanisme d'exit unilatéral documenté
- Source adresses : Arbiscan search results (label "Vertex Protocol: Endpoint", etc.)

**Scanner : non lancé (bloquer architectural) :**
- TOUS les contrats d'implémentation Vertex (Endpoint impl 0x91ffc8, Clearinghouse impl 0x63a497, SpotEngine 0x32d91a, PerpEngine 0xb74c78, OffchainExchange 0xa43698, Querier 0x169327) ne sont PAS vérifiés sur Arbiscan.
- Seuls les proxy wrappers (TransparentUpgradeableProxy) sont vérifiés — sans le code des impls, Slither ne peut pas analyser les permissions réelles.
- `contracts_verified` : **partial** — proxies vérifiés, impls non vérifiées. La surface de permission du code déployé est opaque.

**Unknown / raisons :**
- `permissions_functions` : scanner non lancé (impls non vérifiées).
- `upgrade_delay_seconds` : aucun Timelock détecté dans la chaîne de propriété. Si le Safe 4/6 peut upgrader directement, le délai effectif est 0.
- `slowMode_timeout_seconds` : `slowModeConfig()` reverts on-chain. Valeur exacte du timeout non mesurée.
- `alternative_frontend` : non vérifié.

---

## Limites méthodologiques générales

1. **permission-scanner complété pour gains/gmx-v2/ostium** : fonctions permissionnées listées dans `out/<name>.json`. Vertex non scannable (impls non vérifiées).

2. **contracts_verified** : mesuré via Etherscan API v2. Résultats : gains=true, gmx-v2=true, ostium=true, vertex=partial (proxies vérifiés, impls non).

3. **AccessControl non-enumerable (gains, GMX)** : `getRoleMember()` reverts. Le proposer du GNSTimelockOwner (gains) et les détenteurs des rôles `onlyTimelockMultisig`/`onlyTimelockAdmin` (GMX custom Timelock) ne sont pas résolus. Scan d'events `RoleGranted` requis.

4. **Diamond (gains) : version non confirmable** : EIP-2535 ne stocke pas de numéro de version. "v10.3" ne peut pas être lu d'un slot.

5. **Vertex impls non vérifiées** : finding architectural. Le code déployé en production (Endpoint impl, Clearinghouse impl, moteurs) n'est pas auditable depuis Arbiscan. La surface de permission réelle est inconnue. Source GitHub peut ne pas correspondre au bytecode déployé.

6. **Ostium source primaire manquante** : la doc officielle Ostium est inaccessible (ECONNREFUSED). Les adresses viennent d'une doc dépréciée + Arbiscan labels. Risque modéré d'adresses obsolètes. La cohérence on-chain (ProxyAdmin → Timelock chain) a été vérifiée.
