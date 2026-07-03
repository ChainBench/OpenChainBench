package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"
)

// WalletSnapshot captures wallet USD balances at a point in time. Used by the daily
// P&L cron to compute deltas — how much fees we've burned in the last 24h, per chain.
type WalletSnapshot struct {
	Timestamp time.Time                     `json:"timestamp"`
	Balances  map[string]map[string]float64 `json:"balances"` // chain → token → USD
	TotalUSD  float64                       `json:"total_usd"`
}

const snapshotPath = "/tmp/bridge_wallet_snapshot.json"

// captureSnapshot fetches live balances, strips contract-address keys (we want symbols
// for human-readable diffs), sums total, and returns it.
func captureSnapshot(bc *BalanceChecker) (*WalletSnapshot, error) {
	raw, err := bc.GetAllBalances()
	if err != nil {
		return nil, err
	}

	snap := &WalletSnapshot{
		Timestamp: time.Now().UTC(),
		Balances:  make(map[string]map[string]float64),
	}
	for chain, tokens := range raw {
		snap.Balances[chain] = make(map[string]float64)
		for token, usd := range tokens {
			if strings.HasPrefix(token, "0x") || len(token) > 12 {
				continue
			}
			if usd < 0.01 {
				continue
			}
			snap.Balances[chain][token] = usd
			snap.TotalUSD += usd
		}
	}
	return snap, nil
}

func loadSnapshot() (*WalletSnapshot, error) {
	b, err := os.ReadFile(snapshotPath)
	if err != nil {
		return nil, err
	}
	var s WalletSnapshot
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func saveSnapshot(s *WalletSnapshot) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(snapshotPath, b, 0644)
}

// StartDailyPnLCron fires daily at 09:30 UTC (30 min before scheduled executions)
// and posts a Slack P&L report vs ~24h ago. Safe against redeploys: if the stored
// snapshot is missing or older than 28h we just re-snapshot silently.
func StartDailyPnLCron(bc *BalanceChecker, slack *SlackNotifier) {
	if bc == nil {
		log.Println("⚠️  Daily P&L cron disabled: no balance checker")
		return
	}

	// Seed snapshot on startup if none exists yet.
	if _, err := loadSnapshot(); err != nil {
		if snap, err := captureSnapshot(bc); err == nil {
			_ = saveSnapshot(snap)
			log.Printf("📸 Initial wallet snapshot: $%.2f", snap.TotalUSD)
		} else {
			log.Printf("⚠️  Initial snapshot failed: %v", err)
		}
	}

	go func() {
		for {
			// Sleep until next 09:30 UTC.
			now := time.Now().UTC()
			next := time.Date(now.Year(), now.Month(), now.Day(), 9, 30, 0, 0, time.UTC)
			if !next.After(now) {
				next = next.AddDate(0, 0, 1)
			}
			wait := next.Sub(now)
			log.Printf("📅 Daily P&L cron scheduled for %s (in %v)", next.Format("2006-01-02 15:04 UTC"), wait.Round(time.Minute))
			time.Sleep(wait)

			runDailyPnL(bc, slack)
		}
	}()
}

func runDailyPnL(bc *BalanceChecker, slack *SlackNotifier) {
	current, err := captureSnapshot(bc)
	if err != nil {
		log.Printf("⚠️  P&L cron capture failed: %v", err)
		return
	}

	prev, err := loadSnapshot()
	if err != nil || time.Since(prev.Timestamp) > 28*time.Hour {
		// First run after fresh deploy, or stale snapshot — just store and report absolute.
		_ = saveSnapshot(current)
		if slack != nil {
			msg := fmt.Sprintf("📸 *Wallet Snapshot (no prior data)*\n\n*Total:* $%.2f\n%s",
				current.TotalUSD, formatSnapshotBalances(current))
			_ = slack.send(msg)
		}
		return
	}

	// Compute diffs per (chain, token), sort by impact for readability.
	type diff struct {
		Chain   string
		Token   string
		Before  float64
		After   float64
		Delta   float64
		Percent float64
	}
	var diffs []diff

	seen := make(map[string]bool)
	for chain, tokens := range current.Balances {
		for token, after := range tokens {
			key := chain + "/" + token
			seen[key] = true
			before := prev.Balances[chain][token]
			d := after - before
			pct := 0.0
			if before > 0.01 {
				pct = (d / before) * 100
			}
			diffs = append(diffs, diff{chain, token, before, after, d, pct})
		}
	}
	// Assets that disappeared entirely (fully drained) — show them too.
	for chain, tokens := range prev.Balances {
		for token, before := range tokens {
			if seen[chain+"/"+token] {
				continue
			}
			diffs = append(diffs, diff{chain, token, before, 0, -before, -100})
		}
	}
	sort.Slice(diffs, func(i, j int) bool { return diffs[i].Delta < diffs[j].Delta })

	totalDelta := current.TotalUSD - prev.TotalUSD
	totalPct := 0.0
	if prev.TotalUSD > 0.01 {
		totalPct = (totalDelta / prev.TotalUSD) * 100
	}

	emoji := "📊"
	if totalDelta < -1 {
		emoji = "📉"
	} else if totalDelta > 1 {
		emoji = "📈"
	}

	// Show every token (even unchanged) so the breakdown total reconciles to
	// the headline number — too many readers were confused by missing rows when
	// a token's price was stable.
	var body strings.Builder
	for _, d := range diffs {
		if d.Delta > -0.01 && d.Delta < 0.01 {
			body.WriteString(fmt.Sprintf("• %s/%s: $%.2f (=)\n", d.Chain, d.Token, d.After))
			continue
		}
		sign := "+"
		if d.Delta < 0 {
			sign = ""
		}
		body.WriteString(fmt.Sprintf("• %s/%s: $%.2f → $%.2f (%s$%.2f / %s%.2f%%)\n",
			d.Chain, d.Token, d.Before, d.After, sign, d.Delta, sign, d.Percent))
	}

	hours := time.Since(prev.Timestamp).Hours()
	health := formatTierHealth(current.Balances)
	msg := fmt.Sprintf(`%s *Daily Wallet P&L* (last %.0fh)

*Total:* $%.2f → $%.2f (%+.2f USD / %+.2f%%)

*Breakdown:*
%s
%s`,
		emoji, hours, prev.TotalUSD, current.TotalUSD, totalDelta, totalPct, body.String(), health,
	)

	if slack != nil {
		if err := slack.send(msg); err != nil {
			log.Printf("⚠️  P&L Slack send failed: %v", err)
		}
	}
	log.Printf("📊 Daily P&L: $%.2f → $%.2f (%+.2f USD)", prev.TotalUSD, current.TotalUSD, totalDelta)

	_ = saveSnapshot(current)
}

// formatTierHealth produces the "can each tier run?" section of the daily report.
//
// Reality of a scheduled cycle (main.go): routes run sequentially R1 → R2 → R3, each
// RunReal blocks until its 3 bridges fully settle on the destination chain. So R2
// starts AFTER R1 has delivered ~3×amount × 99% to Base, and R3 starts AFTER R2 has
// delivered ~3×amount × 99% to Arb. The per-leg requirement is therefore:
//
//   R1 source (Sol USDC):  initial ≥ 3 × amount        (no preceding inflow)
//   R2 source (Base USDC): initial + R1_inflow ≥ 3×amount
//   R3 source (Arb USDT):  initial + R2_inflow ≥ 3×amount
//
// where inflow ≈ 3×amount × (1 - avg_fee). Using a conservative 2% cumulative loss.
func formatTierHealth(balances map[string]map[string]float64) string {
	const netFactor = 0.98 // 1 - 2% cumulative fees per 3-bridge hop

	solUSDC := balances["Solana"]["USDC"]
	baseUSDC := balances["Base"]["USDC"]
	arbUSDT := balances["Arbitrum"]["USDT0"]
	tiers := []float64{5, 50, 300}

	// Simulate the cycle for a given tier using the sequential per-bridge model
	// (1× tier per leg, matches cycle_sim.SimulateTriangleCycle). Shared logic
	// kept inline for the dashboard-style grid output.
	type result struct {
		r1OK, r2OK, r3OK bool
		blockLeg         string
		blockNeed        float64
		blockHave        float64
	}
	simulate := func(t float64) result {
		need := t // sequential per-bridge: 1× tier per leg
		r := result{}

		if solUSDC < need {
			return result{blockLeg: "R1 Sol USDC", blockNeed: need, blockHave: solUSDC}
		}
		r.r1OK = true
		baseEffective := baseUSDC + need*netFactor // R1 inflow

		if baseEffective < need {
			return result{r1OK: true, blockLeg: "R2 Base USDC", blockNeed: need, blockHave: baseEffective}
		}
		r.r2OK = true
		arbEffective := arbUSDT + need*netFactor // R2 inflow

		if arbEffective < need {
			return result{r1OK: true, r2OK: true, blockLeg: "R3 Arb USDT", blockNeed: need, blockHave: arbEffective}
		}
		r.r3OK = true
		return r
	}

	// Grid.
	var grid strings.Builder
	grid.WriteString("\n🩺 *Tier Health* (sequential per-bridge · 1× tier per leg)\n```\n")
	grid.WriteString("             $5     $50    $300\n")
	rows := []struct {
		label string
		get   func(result) bool
	}{
		{"R1 Sol USDC ", func(r result) bool { return r.r1OK }},
		{"R2 Base USDC", func(r result) bool { return r.r2OK }},
		{"R3 Arb USDT ", func(r result) bool { return r.r3OK }},
	}
	results := make(map[float64]result)
	for _, t := range tiers {
		results[t] = simulate(t)
	}
	for _, row := range rows {
		grid.WriteString(row.label)
		for _, t := range tiers {
			status := "❌"
			if row.get(results[t]) {
				status = "✅"
			}
			grid.WriteString(fmt.Sprintf("  %s   ", status))
		}
		grid.WriteString("\n")
	}
	grid.WriteString("```\n")

	// Per-tier actionable message for blocked tiers.
	tierEmoji := map[float64]string{5: "⚡", 50: "💰", 300: "💎"}
	tierLabel := map[float64]string{5: "daily", 50: "Mon+Thu", 300: "Mon weekly"}

	for _, t := range tiers {
		r := results[t]
		if r.r1OK && r.r2OK && r.r3OK {
			continue
		}
		gap := r.blockNeed - r.blockHave
		grid.WriteString(fmt.Sprintf("\n%s *$%.0f tier (%s)* — blocks on %s\n",
			tierEmoji[t], t, tierLabel[t], r.blockLeg))
		grid.WriteString(fmt.Sprintf("  need $%.2f, have $%.2f → *bridge +$%.2f minimum*\n", r.blockNeed, r.blockHave, gap))

		// Can we cover it from other legs? (for R1 Sol blocker only — R2/R3 fed by upstream)
		if strings.HasPrefix(r.blockLeg, "R1") {
			totalStable := solUSDC + baseUSDC + arbUSDT
			if totalStable < r.blockNeed {
				grid.WriteString(fmt.Sprintf("  ⚠️ total stable pool $%.2f < $%.2f required — tier not viable without external top-up of $%.0f\n",
					totalStable, r.blockNeed, r.blockNeed-totalStable))
			} else {
				grid.WriteString(fmt.Sprintf("  → pull from Base USDC ($%.0f) or Arb USDT ($%.0f) to Sol USDC\n", baseUSDC, arbUSDT))
			}
		}
	}

	// Gas sanity check (each cycle = ~3 outgoing TX per EVM chain).
	var gasWarn strings.Builder
	checkGas := func(chain, token string, min float64) {
		if v := balances[chain][token]; v > 0 && v < min {
			gasWarn.WriteString(fmt.Sprintf("  • %s %s: $%.2f (< $%.2f) — top up native\n", chain, token, v, min))
		}
	}
	checkGas("Solana", "SOL", 1.0)
	checkGas("Base", "ETH", 3.0)
	checkGas("Arbitrum", "ETH", 3.0)
	if gasWarn.Len() > 0 {
		grid.WriteString("\n⛽ *Gas warning*:\n")
		grid.WriteString(gasWarn.String())
	}

	return grid.String()
}

func formatSnapshotBalances(s *WalletSnapshot) string {
	var b strings.Builder
	for chain, tokens := range s.Balances {
		for token, usd := range tokens {
			b.WriteString(fmt.Sprintf("• %s/%s: $%.2f\n", chain, token, usd))
		}
	}
	return b.String()
}
