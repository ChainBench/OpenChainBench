package main

import (
	"fmt"
	"time"
)

// Assets Maya actually carries, verified from its own pool list on
// 2026-10-25: ZEC.ZEC and DASH.DASH, both Available. Chainflip carries
// neither, confirmed with two controls that pass (Solana/SOL and
// Bitcoin/BTC both quote 200 while ZEC, XMR and DASH all refuse), and
// THORChain was unreachable on twelve hosts, so neither is probed until a
// live endpoint exists.
var mayaAssets = []string{"ZEC.ZEC", "DASH.DASH"}

// runScheduler ticks every probe on one clock.
//
// The interval defaults to 300 s rather than 60: every number here comes
// from a quote, and a quote is a request a venue serves for free. Three
// rails times three size rungs times two assets is already 18 calls a tick
// on Maya alone, and a prober that costs a venue more than it learns gets
// blocked, which is how a board goes dark.
func runScheduler(cfg *Config, stop <-chan struct{}) {
	shieldedReady := VerifyDestinations(cfg) == nil
	if !shieldedReady {
		fmt.Printf("delivery probe DISABLED: %v\n", VerifyDestinations(cfg))
	}

	tick := func() {
		for _, a := range mayaAssets {
			probeMayaRoundTrip(cfg, a)
			probeMayaExitCost(cfg, a)
		}
		probeMayaDepth(cfg, mayaAssets)

		for _, a := range thorAssets {
			probeThorRoundTrip(cfg, a)
		}
		probeThorDepth(cfg)

		// NEAR Intents round trip: USDC in, ZEC, USDC back. Both legs
		// quote, verified on 2026-10-26 at 63 bps and 607 s for $1k.
		probeNearRoundTrip(cfg)

		if shieldedReady {
			probeOneClick(cfg)
			// Maya's refusal is the other half of the finding, so it is
			// measured rather than asserted: the destination rides in the
			// deposit memo there, and the probe records which reason the
			// rail gives rather than assuming the memo one still holds.
			probeMayaDelivery(cfg)
			probeThorDelivery(cfg)
		}

		probeXmr(cfg)
	}

	tick()
	t := time.NewTicker(cfg.TickInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			tick()
		}
	}
}

// probeMayaDelivery asks Maya for a ZEC payout to each destination kind from
// each source chain it routes. BTC and DASH are the two sources confirmed to
// route on 2026-10-25; ARB.ETH refused BOTH address kinds for want of
// liquidity, which is exactly why the transparent control exists here.
func probeMayaDelivery(cfg *Config) {
	for _, src := range []struct {
		asset, chain string
		amount       int64
	}{
		{"BTC.BTC", "bitcoin", 10_000_000},
		{"DASH.DASH", "dash", 100_000_000},
	} {
		s := src
		probeDelivery(cfg, "maya", s.chain, func(recipient string) (bool, string, error) {
			q, code, err := mayaQuoteSwap(cfg, s.asset, "ZEC.ZEC", s.amount, recipient)
			if err != nil && code == 0 {
				return false, "", err
			}
			if q.Error != "" {
				return false, q.Error, nil
			}
			if _, e := q.out(); e != nil {
				return false, e.Error(), nil
			}
			return true, "", nil
		})
	}
}
