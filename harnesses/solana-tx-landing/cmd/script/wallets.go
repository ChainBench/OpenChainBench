package main

// Tip wallets for each Solana transaction landing service.
//
// These addresses are the ON-CHAIN destinations users tip when they
// route a tx through a landing service. By watching the `mentions`
// firehose on each wallet, we attribute landed tx → service without
// sending any tx ourselves (zero on-chain footprint, zero SOL cost).
//
// Verified live before inclusion (vanity-prefix + balance/sig checks
// against mainnet RPC). Sources documented per-service below.
//
// Cleanly attributable (8 services): Jito, Helius Sender, Nozomi,
// bloXroute, 0slot, NextBlock, Astralane, SolanaVibeStation.
//
// Blind spots: Syncro Sender (per-customer wallets, undisclosed),
// Slipstream (pure router — its tx land via underlying senders'
// wallets and get attributed to those).

type Service string

const (
	ServiceJito              Service = "jito"
	ServiceHeliusSender      Service = "helius-sender"
	ServiceNozomi            Service = "nozomi"
	ServiceBloxroute         Service = "bloxroute"
	Service0slot             Service = "0slot"
	ServiceNextBlock         Service = "nextblock"
	ServiceAstralane         Service = "astralane"
	ServiceSolanaVibeStation Service = "solanavibestation"
)

// walletToService maps every known tip address to its owning service.
// Used by the dispatcher to attribute every `logsSubscribe(mentions)`
// notification to the right counter.
var walletToService = map[string]Service{}

func init() {
	for service, wallets := range walletsByService() {
		for _, w := range wallets {
			walletToService[w] = service
		}
	}
}

// walletsByService returns the source-of-truth grouping. Used by main
// to build the subscription list (one logsSubscribe per wallet) and
// by init() above to invert into walletToService.
func walletsByService() map[Service][]string {
	return map[Service][]string{
		// Jito Block Engine — docs.jito.wtf/lowlatencytxnsend/
		ServiceJito: {
			"96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
			"HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
			"Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
			"ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
			"DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
			"ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBjNo7XZQshxw3",
			"DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
			"3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
		},
		// Helius Sender — helius.dev/docs/sending-transactions/sender
		// Disjoint from Jito's 8 — Helius operates its own SWQoS pool.
		ServiceHeliusSender: {
			"4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
			"D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
			"9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
			"5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
			"2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
			"2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
			"wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
			"3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
			"4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
			"4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
		},
		// Nozomi (Temporal Labs) — use.temporal.xyz/nozomi
		// First wallet is the one the prober actually tips (pickTipWallets
		// uses wallets[0]). Per Jakob @ Temporal Labs (2026-05-24), the
		// "main" wallets like TEMPaMeCRFAS... get saturated under MEV load;
		// clients typically rotate over several less-busy wallets. The
		// non-saturated tip wallet below was recommended directly.
		ServiceNozomi: {
			"nEFs3jph8HJt7honu3k7XtGUufMnwAvSXmXcKSPxryP",
			"TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq",
			"noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4",
			"noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE",
			"noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo",
			"noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ",
			"nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L",
			"nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z",
			"nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu",
			"noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7",
			"nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP",
			"nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P",
			"nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge",
			"nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3",
			"nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ",
			"nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk",
			"nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne",
			"nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb",
		},
		// bloXroute Trader API — docs.bloxroute.com/solana/trader-api
		ServiceBloxroute: {
			"3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd",
			"FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF",
			"bLx7MvxGaKdKL7mEbpk9tC79z6MnBSJoJkuaEAPu6Nd",
			"bLx7XBqSg3LUPVf1bRgCnkJmgVZR8QEgDJBPqcRLHvp",
			"bLx8KeZxinPwy6kkUgyzMLeqb2ARNsWjADG1dhSsVba",
			"bLxADBknoNj8WAGw2W6GBYeq848Xx6ajhaymV1YvrHm",
			"bLxAc88vRBwvcUQJEgcxNfBLvHPikY4csNsUmPeWea2",
			"bLxQ88oCiTsL8Xj4YWekKi1hjrgmbE3J3FFZ2xZHR3h",
			"bLxS7NoLuynNRJ4mCnEE2YbtwJFttYsEyp2ME7rp2yt",
			"bLxW6mCov7VEbrKc3S9tcBRcfSzRnLCbNp3Dfn3SJG5",
			"bLxXSGXs4mYPTC5okZXed1qzvjNwNJ48QJ82hT2V7w7",
			"bLxYi3vojbbB7hVzVDVTdBLVPhp7GJ3ZB3BwdK5sFXi",
			"bLxhLPgBXtUpX4b1bH3HatuMGMSKT9GnwtuCGiMSAqe",
			"bLxpY1mniuFW4PgkNA4JiNxoeKHFszryi6tNgyZAiAA",
			"bLxuETxd2tgWxBALNwPzAfHhsik4BzD3nrEBCiPNZQD",
			"bLxuL2gK5FW7xfahvwLrxLyW76vcCpNsKQY2CmnE6kV",
			"bLxv4Hnub7nDJWHs8s17o9bGU65Bnx6Yqp2fqtMgHmm",
		},
		// 0slot.trade — 0slot.trade/docs.php
		Service0slot: {
			"4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4",
			"7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK",
			"8mR3wB1nh4D6Y9b8AcwQEJrnpkdjfvHm56hdQ7Yqxe9P",
			"6fQaVhYZA4w3MBSXjJ81Vf6W1EDuaybPTYTxz5KrkpaC",
			"TpdxgNJBWZRL8UXF5mrEsyWxDWx9HQexA9P1eTWQ42p",
			"D8f3WkQu6dCF33cZxuAsrKHrGsqGP2yvAHf8mX6uXqVL",
			"GQPFicsy3P3NXxB5piJohoxACqTvWE9fKpLgdsMduoHE",
			"Ey2JEr8hDkgN8qKJGrLf2yFjRhW7rab99HVxwi5rcvJE",
			"4iUgjMT8q2hNZcLzgcGzKZmtCEMS2cFbn5WtSWfBfPVS",
			"3Sv94XZpawnKJW2YEUKurZHKLRyXfBP3CV3MMABnB9sP",
		},
		// NextBlock — docs.nextblock.io
		ServiceNextBlock: {
			"NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE",
			"NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2",
			"NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X",
			"NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb",
			"neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At",
			"nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG",
			"NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid",
			"nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc",
		},
		// Astralane Iris — astralane.gitbook.io
		// Only one address documented in 2026. If they add regional
		// variants, they'll appear here.
		ServiceAstralane: {
			"astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm",
		},
		// SolanaVibeStation Lightspeed — docs.solanavibestation.com
		ServiceSolanaVibeStation: {
			"svsMoWJBwLcs8JgfN8VaF111tAc199KpYeTKRwxRtip",
		},
	}
}

// allWallets returns the flat list of every wallet we subscribe to.
// One logsSubscribe call per wallet on the WS connection.
func allWallets() []string {
	out := make([]string, 0, len(walletToService))
	for w := range walletToService {
		out = append(out, w)
	}
	return out
}
