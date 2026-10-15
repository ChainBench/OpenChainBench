# solana-tx-landing harness

Source for the OpenChainBench bench [`solana-tx-landing`](https://openchainbench.com/benchmarks/solana-tx-landing) (№ 016): market share of Solana transaction landing services (Jito, Helius Sender, Nozomi, bloXroute, 0slot, NextBlock, Astralane, SolanaVibeStation), measured from the tips paid to each service's published tip wallets.

It sends no transaction and spends no SOL. Exposes Prometheus metrics on `:2112/metrics`.

## How it works

One WebSocket to Solana mainnet holds a `logsSubscribe({mentions:[wallet]}, {commitment:"confirmed"})` per tip wallet (84 wallets, `cmd/script/wallets.go`). Every successful confirmed transaction that mentions a wallet is counted for the service that owns it. Failed transactions are dropped.

Dedup is per (service, signature) in a 50,000-entry LRU: a reconnect replay never counts twice, and a transaction that tips two services (Helius Sender's dual path pays Helius and Jito) counts once for each.

## Metrics

```
solana_landing_tx_total{service}               counter  attributed landed tx
solana_landing_subscription_health{service}    gauge    1 while the service's subscriptions are acked
solana_landing_reconnects_total                counter  WebSocket reconnects
solana_landing_last_slot{service}              gauge    slot of the last attributed tx
```

## Run

```bash
go run ./cmd/script
curl localhost:2112/metrics | grep solana_landing
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `SOLANA_WS_URL` | `wss://api.mainnet-beta.solana.com` | Must accept ~84 subscriptions on one socket. Chainstack's plan rejected part of them (`-32005`) on 2026-10-15, so the public endpoint is used. |
| `LOGS_TOKEN` | (unset) | Optional, gates `/logs?tail=N` |

## Keeping the wallet list honest

A wallet a service adds or rotates without us updating `wallets.go` is silently under-counted. On 2026-10-15 every address was checked to have confirmed transactions that day. Jito's list was diffed against the live `getTipAccounts`, and Helius Sender, bloXroute and 0slot against their docs. That pass found 6 corrupted addresses and 11 missing 0slot wallets. Re-run the same check before trusting a sudden drop in one service.

## Deploy

The harness runs on the OCB VPS as the `ocb-solana-tx-landing` container on the `ocb_web` network. It is scraped as the `solana-tx-landing` job in `/opt/ocb/prometheus.yml`.
