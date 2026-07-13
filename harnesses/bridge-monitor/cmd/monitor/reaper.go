package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// Stuck-fund reaper: the triangle expects inventory on exactly three legs
// (Sol USDC, Base USDC, Arb USDT) plus native gas. Refunds and partial fills
// sometimes leave capital elsewhere (typically USDC on Arbitrum after an R3
// refund), where no scheduled route will ever pick it up again. The reaper
// tracks how long such balances sit stranded, exports that as a gauge for
// alerting, and, when execution is enabled, sends ONE corrective transfer per
// hourly tick back to the neediest home leg.

// Ignore balances below this: bridge dust and rounding leftovers are not worth
// a corrective transfer's fees.
const strandedDustUSD = 1.0

// Reaper transfers share the rebalancer's spirit of "never move more than a
// tier plus buffer": one capped hop per tick instead of one big blind sweep.
const reaperMaxTransferUSD = 300 * rebalanceBufferFactor

// Tokens that are SUPPOSED to sit on each chain. Everything else above the
// dust floor counts as stranded. TRUMP and BRETT are meme-route inventory,
// native SOL and ETH are gas.
var homeTokens = map[string]map[string]bool{
	"Solana":   {"USDC": true, "SOL": true, "TRUMP": true},
	"Base":     {"USDC": true, "ETH": true, "BRETT": true},
	"Arbitrum": {"USDT0": true, "USDT": true, "ETH": true},
}

// Stranded tokens we know how to route home. Anything else is alert-only:
// building a bridge TX for an unknown asset from inside a repair loop is how
// funds get burned, so we only ever move assets we have addresses for.
var movableStranded = map[string]map[string]string{
	"Solana":   {"USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"},
	"Base":     {"USDT": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"},
	"Arbitrum": {"USDC": arbUSDCAddr},
}

type strandKey struct {
	Chain string
	Token string
}

// StrandedTracker remembers when each off-home balance was first seen so the
// stranded duration survives across ticks (but not restarts: a restart resets
// the clock, which only delays the reaper, never makes it over-eager).
type StrandedTracker struct {
	firstSeen map[strandKey]time.Time
}

func NewStrandedTracker() *StrandedTracker {
	return &StrandedTracker{firstSeen: make(map[strandKey]time.Time)}
}

// Update computes stranded hours for every off-home balance in the snapshot
// and returns them, including explicit zeros for keys that just came home so
// the exported gauge resets. Pure given (balances, now), unit-tested.
func (t *StrandedTracker) Update(balances map[string]map[string]float64, now time.Time) map[strandKey]float64 {
	hours := make(map[strandKey]float64)

	// Zero out anything previously tracked; re-add below if still stranded.
	for k := range t.firstSeen {
		hours[k] = 0
	}

	for chain, tokens := range balances {
		home := homeTokens[chain]
		for token, usd := range tokens {
			// Contract-address keys duplicate the symbol entries.
			if strings.HasPrefix(token, "0x") || len(token) > 12 {
				continue
			}
			if usd <= strandedDustUSD || (home != nil && home[token]) {
				delete(t.firstSeen, strandKey{chain, token})
				continue
			}
			k := strandKey{chain, token}
			first, seen := t.firstSeen[k]
			if !seen {
				first = now
				t.firstSeen[k] = first
			}
			hours[k] = now.Sub(first).Hours()
		}
	}

	// Drop firstSeen entries that vanished from the snapshot entirely.
	for k := range t.firstSeen {
		if _, still := hours[k]; !still {
			delete(t.firstSeen, k)
		}
	}
	for k, h := range hours {
		if h == 0 {
			delete(t.firstSeen, k)
		}
	}
	return hours
}

// StartReaper launches the hourly stuck-fund loop. The gauge side runs in
// every mode, including while BENCHMARK_PAUSED, because alerting must keep
// working during a pause. The corrective transfer only fires in production
// mode, unpaused, with broadcast-capable keys.
func StartReaper(bc *BalanceChecker, rebalancer *Rebalancer, slack *SlackNotifier, mode string, paused bool) {
	if bc == nil {
		log.Println("🧹 Reaper disabled: no balance checker")
		return
	}

	strandedHours := parseFloat(os.Getenv("REAPER_STRANDED_HOURS"), 6)
	tracker := NewStrandedTracker()

	canAct := mode == "production" && !paused && rebalancer.canAct()
	log.Printf("🧹 Stuck-fund reaper started (threshold %.0fh, acting=%v)", strandedHours, canAct)

	go func() {
		// First evaluation immediately so gauges exist right after boot, then hourly.
		reaperTick(bc, rebalancer, slack, tracker, strandedHours, canAct)
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			reaperTick(bc, rebalancer, slack, tracker, strandedHours, canAct)
		}
	}()
}

func reaperTick(bc *BalanceChecker, rebalancer *Rebalancer, slack *SlackNotifier,
	tracker *StrandedTracker, thresholdHours float64, canAct bool,
) {
	balances, degraded, err := bc.GetAllBalancesDetailed()
	if err != nil || degraded {
		// Without trustworthy balances we cannot tell stranded from home, so
		// neither the gauge nor a transfer would mean anything this tick.
		log.Printf("🧹 Reaper tick skipped: balances unreadable (degraded=%v err=%v)", degraded, err)
		return
	}

	hours := tracker.Update(balances, time.Now().UTC())

	// Home legs always report 0 so alert expressions have a baseline series.
	for _, leg := range triangleLegs {
		sym := leg.Token
		if leg.Chain == "Arbitrum" {
			sym = "USDT0"
		}
		bridgeStrandedHours.WithLabelValues(leg.Chain, sym).Set(0)
	}
	for k, h := range hours {
		bridgeStrandedHours.WithLabelValues(k.Chain, k.Token).Set(h)
	}

	// Pick the single worst offender above threshold; one transfer per tick
	// keeps the blast radius of a bad tick to one capped TX.
	var worst strandKey
	worstHours := 0.0
	for k, h := range hours {
		if h >= thresholdHours && h > worstHours {
			worst, worstHours = k, h
		}
	}
	if worstHours == 0 {
		log.Printf("🧹 Reaper tick: no funds stranded beyond %.0fh", thresholdHours)
		return
	}

	amount := balances[worst.Chain][worst.Token]
	log.Printf("🧹 Stranded funds: $%.2f %s on %s for %.1fh (threshold %.0fh)",
		amount, worst.Token, worst.Chain, worstHours, thresholdHours)

	if !canAct {
		// Read-only mode: the gauge above is the alert path, a human handles it.
		return
	}

	srcAddr, known := movableStranded[worst.Chain][worst.Token]
	if !known {
		_ = slack.NotifyReaper(fmt.Sprintf(
			"$%.2f of %s stranded on %s for %.1fh, but I have no safe route for that asset. Manual rebalance needed (cmd/rebalance).",
			amount, worst.Token, worst.Chain, worstHours))
		return
	}

	if rebalancer.executor.config.DailySpentUSD >= rebalancer.executor.config.MaxDailySpendUSD {
		_ = slack.NotifyReaper(fmt.Sprintf(
			"$%.2f of %s stranded on %s for %.1fh, but daily spend limit is reached ($%.2f / $%.2f). Will retry next tick.",
			amount, worst.Token, worst.Chain, worstHours,
			rebalancer.executor.config.DailySpentUSD, rebalancer.executor.config.MaxDailySpendUSD))
		return
	}

	dest := neediestHomeLeg(balances)
	if amount > reaperMaxTransferUSD {
		amount = reaperMaxTransferUSD
	}

	route := TestRoute{
		Name:         fmt.Sprintf("REAPER_%s_%s", strings.ToUpper(worst.Chain), strings.ToUpper(dest.Chain)),
		FromChain:    worst.Chain,
		FromChainAPI: chainAPIFor(worst.Chain),
		FromToken:    srcAddr,
		ToChain:      dest.Chain,
		ToChainAPI:   dest.ChainAPI,
		ToToken:      dest.TokenAddr,
		IsSolanaSrc:  worst.Chain == "Solana",
	}

	_ = slack.NotifyReaper(fmt.Sprintf(
		"Moving $%.2f of stranded %s from %s (stuck %.1fh) home to %s %s via cheapest bridge.",
		amount, worst.Token, worst.Chain, worstHours, dest.Chain, dest.Token))

	result := rebalancer.ExecuteCheapest(route, amount)
	if result == nil || !result.Success {
		detail := "no bridge produced a usable quote"
		if result != nil && result.Error != nil {
			detail = result.Error.Error()
		}
		_ = slack.NotifyReaper(fmt.Sprintf("Corrective transfer FAILED: %s. Will retry next tick.", detail))
		return
	}

	rebalancer.executor.config.DailySpentUSD += result.ActualFeeUSD
	_ = slack.NotifyReaper(fmt.Sprintf(
		"Corrective transfer succeeded via %s (fee $%.4f, tx %s).", result.Bridge, result.ActualFeeUSD, result.TxHash))
}

// neediestHomeLeg returns the triangle leg with the lowest balance: stranded
// funds should land where they unblock the next scheduled cycle soonest.
func neediestHomeLeg(balances map[string]map[string]float64) legSpec {
	best := triangleLegs[0]
	bestBal := legBalanceUSD(balances, best)
	for _, leg := range triangleLegs[1:] {
		if b := legBalanceUSD(balances, leg); b < bestBal {
			best, bestBal = leg, b
		}
	}
	return best
}

func chainAPIFor(chain string) string {
	if leg, ok := findLeg(chain); ok {
		return leg.ChainAPI
	}
	return ""
}
