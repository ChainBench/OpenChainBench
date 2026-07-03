package main

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// Sanity bounds: any USD figure outside these is a pricing artifact,
// not a legitimate swap economic. Calibrated against Relay's real
// population — largest observed leg in the May 2026 audit was ~$10M,
// largest legitimate margin under $1k.
//
// Tighter `maxMarginUSD` after the June 2026 audit: a small number of
// swaps with margin in the -$2M to -$5M range were polluting the 7d /
// 30d aggregates with persistent negative totals. Those margins are
// mathematically impossible for an honest routing protocol; they
// reflect a stale price on one leg vs Relay's `amountUsd` hint on the
// other. We now drop anything outside ±$10k as implausible and emit
// the count on `relay_swaps_dropped_implausible{label=margin}`.
//
// A separate `minMarginUSD` floor catches the negative tail
// specifically: even a $5k legitimate loss on a single swap is so rare
// for a maker-style router that treating it as data quality is the
// right default. Genuine outliers can be re-included by relaxing this
// without redeploying the harness once the upstream pricing is fixed.
const (
	maxLegUSD    = 1e9     // $1B per swap leg
	maxMarginUSD = 1e4     // $10k absolute margin per swap
	minMarginUSD = -5e3    // -$5k floor: more negative = pricing artifact
)

// isImplausibleUSD returns true for NaN/Inf or values outside the
// per-leg sanity envelope. Centralised so every USD-producing path
// uses the same guard.
func isImplausibleUSD(v float64) bool {
	return math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > maxLegUSD
}

// compute.go — implements the implied-margin formula:
//
//   implied_margin_usd = usd_in - usd_out - sum(gas_usd) - sum(appFees_usd)
//
// where:
//   * usd_in/out use data.metadata.currencyIn/out (amount in raw
//     smallest unit; we apply decimals + USD price).
//   * gas = sum over data.inTxs[].fee + data.outTxs[].fee, each priced
//     in the native token of the tx's chainId.
//   * appFees = sum over data.appFees[].amount, priced in
//     data.appFees[].currency (typically USDC).
//
// Pricing strategy per currency leg, in order:
//   1. Relay's own `amountUsd` hint when present (computed at swap time)
//   2. Stable peg by symbol (USDC, USDT, DAI, FRAX, USDe, …)
//   3. Native asset of a known chain via CG slug from chainSpec
//   4. ERC-20 / SPL via PriceTokenUSD(chainId, address)
//   5. Bare symbol fallback (rarely helps; kept for tests)
//
// Returns a Swap with Priced=true ONLY when every required leg priced
// successfully. A single missing price flips Priced=false; we still
// store the swap so downstream consumers see "we saw it but couldn't
// value it" instead of silently losing volume.

// ComputeMargin runs the formula on one Relay request.
func ComputeMargin(ctx context.Context, req RelayRequest, pricer Pricer) (Swap, error) {
	createdAt, err := parseRelayTimestamp(req.CreatedAt)
	if err != nil {
		return Swap{}, fmt.Errorf("parse createdAt: %w", err)
	}

	s := Swap{
		ID:        req.ID,
		CreatedAt: createdAt,
		Status:    req.Status,
		ChainIn:   req.Data.Metadata.CurrencyIn.Currency.ChainID,
		ChainOut:  req.Data.Metadata.CurrencyOut.Currency.ChainID,
		Priced:    true, // optimistic, flipped to false on any miss
	}

	usdIn, ok := amountToUSD(ctx, pricer, req.Data.Metadata.CurrencyIn)
	if !ok {
		s.Priced = false
	}
	s.VolumeUSD = usdIn

	usdOut, ok := amountToUSD(ctx, pricer, req.Data.Metadata.CurrencyOut)
	if !ok {
		s.Priced = false
	}

	gasUSD, gasOK := sumGasUSD(ctx, pricer, req.Data.InTxs, req.Data.OutTxs)
	if !gasOK {
		s.Priced = false
	}
	s.GasUSD = gasUSD

	feesUSD, feesOK := sumAppFeesUSD(ctx, pricer, req.Data.AppFees)
	if !feesOK {
		s.Priced = false
	}
	s.AppFeesUSD = feesUSD

	if s.Priced {
		s.MarginUSD = usdIn - usdOut - gasUSD - feesUSD
		// Two guards, both treat the swap as a pricing artifact rather
		// than data:
		//   1. |margin| > $10k — almost no legitimate Relay swap has a
		//      margin this big; values that large indicate one leg was
		//      priced from a stale or wrong source.
		//   2. margin < -$5k — even a moderate negative margin is
		//      mathematically impossible for an honest router (it would
		//      mean Relay paid the user MORE than they sent). When this
		//      fires, it's the stale-price-on-one-leg-vs-Relay-hint-on-
		//      the-other case. Dropping these prevents the 7d/30d
		//      aggregates from going persistently negative.
		// In both cases we flip Priced=false (so the swap is excluded
		// from volume + margin sums but still counted as unpriced) and
		// emit a Railway stdout line so the offending swap is debuggable.
		if math.Abs(s.MarginUSD) > maxMarginUSD || s.MarginUSD < minMarginUSD {
			fmt.Printf("[implausible] swap=%s margin_usd=%.3e usd_in=%.3e usd_out=%.3e gas=%.3e fees=%.3e chains=%d→%d\n",
				s.ID, s.MarginUSD, usdIn, usdOut, gasUSD, feesUSD, s.ChainIn, s.ChainOut)
			relaySwapsDroppedImplausible.WithLabelValues("margin").Inc()
			s.Priced = false
			s.MarginUSD = 0
		}
	}
	return s, nil
}

// amountToUSD converts a RelayAmount (raw smallest unit + currency
// metadata) to USD.
//
// Short-circuit: when Relay populated `amountUsd` for the leg, we use
// that directly. That's Relay's own price at the swap timestamp, which
// is the *correct* number for an after-the-fact USD valuation — better
// than recomputing with our spot price minutes/hours later (especially
// during backfill). Falls back to our own pricer when the hint is
// absent or unparseable.
func amountToUSD(ctx context.Context, pricer Pricer, amt RelayAmount) (float64, bool) {
	if amt.Amount == "" || amt.Currency.Symbol == "" {
		return 0, true // empty leg is valid (zero), not a pricing failure
	}
	if v, ok := parseRelayUSDHint(amt.AmountUSD); ok {
		return v, true
	}
	priceUSD, ok := resolvePrice(ctx, pricer, amt.Currency)
	if !ok {
		return 0, false
	}
	scaled, ok := scaleAmount(amt.Amount, amt.Currency.Decimals)
	if !ok {
		return 0, false
	}
	val := scaled * priceUSD
	// Catches the (decimals=0 in Relay response) × (corrupted oracle
	// price) blow-ups that produced -1.5e+61 in prod. Mark unpriced
	// instead of writing a Mt-Everest USD into the DB.
	if isImplausibleUSD(val) {
		relaySwapsDroppedImplausible.WithLabelValues("amount").Inc()
		return 0, false
	}
	return val, true
}

// parseRelayUSDHint reads RelayAmount.AmountUSD. Treat anything ≤ 0 or
// unparseable as "no hint" so the caller falls through to our pricer.
// Implausibly large hints (Relay-side encoding glitch) are also
// rejected — the caller's pricer fallback will either compute a sane
// value or flip the swap to unpriced.
func parseRelayUSDHint(raw string) (float64, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	if isImplausibleUSD(v) {
		relaySwapsDroppedImplausible.WithLabelValues("hint").Inc()
		return 0, false
	}
	return v, true
}

// sumGasUSD walks in+out txs and converts each .fee to USD using the
// native asset of the tx's chainId. Returns ok=false if any chain is
// unknown (we can't price it) — that lets the caller mark the swap as
// unpriced rather than silently undercounting cost.
func sumGasUSD(ctx context.Context, pricer Pricer, inTxs, outTxs []RelayTx) (float64, bool) {
	total := 0.0
	ok := true
	for _, tx := range append(append([]RelayTx{}, inTxs...), outTxs...) {
		if tx.Fee == "" || tx.Fee == "0" {
			continue
		}
		cs, found := chainSpec(tx.ChainID)
		if !found {
			ok = false
			continue
		}
		priceUSD, priceOK := priceNative(ctx, pricer, cs)
		if !priceOK {
			ok = false
			continue
		}
		scaled, scaledOK := scaleAmount(tx.Fee, cs.NativeDecimals)
		if !scaledOK {
			ok = false
			continue
		}
		val := scaled * priceUSD
		if isImplausibleUSD(val) {
			relaySwapsDroppedImplausible.WithLabelValues("gas").Inc()
			ok = false
			continue
		}
		total += val
	}
	return total, ok
}

// priceNative resolves a chain's gas-token USD price. Tries Mobula-
// specific asset names first (Mobula's vocabulary diverges from
// CoinGecko's on BNB/POL/AVAX), then falls through to the canonical
// CoinGecko id, then the bare symbol. Either pricer in the chain wins
// at the first hit.
func priceNative(ctx context.Context, pricer Pricer, cs ChainSpec) (float64, bool) {
	if cs.MobulaNativeAsset != "" {
		if v, ok := pricer.PriceUSD(ctx, cs.MobulaNativeAsset, cs.NativeSymbol); ok {
			return v, true
		}
	}
	if v, ok := pricer.PriceUSD(ctx, cs.NativeCoingeckoID, cs.NativeSymbol); ok {
		return v, true
	}
	return 0, false
}

// sumAppFeesUSD sums RelayAppFee[].amount priced in each fee's
// declared currency. Empty appFees → 0, ok=true (very common, 29%).
// Degenerate entries (Amount > 0 but the Currency block is missing
// chainId / address / symbol) appear in the swap stream; we treat them
// as Relay-data noise and skip the contribution rather than flip the
// whole swap to unpriced.
func sumAppFeesUSD(ctx context.Context, pricer Pricer, fees []RelayAppFee) (float64, bool) {
	total := 0.0
	ok := true
	for _, f := range fees {
		if f.Amount == "" || f.Amount == "0" {
			continue
		}
		if isCurrencyEmpty(f.Currency) {
			continue // Relay quirk: skip without flipping ok=false
		}
		priceUSD, priceOK := resolvePrice(ctx, pricer, f.Currency)
		if !priceOK {
			ok = false
			continue
		}
		scaled, scaledOK := scaleAmount(f.Amount, f.Currency.Decimals)
		if !scaledOK {
			ok = false
			continue
		}
		val := scaled * priceUSD
		if isImplausibleUSD(val) {
			relaySwapsDroppedImplausible.WithLabelValues("appfee").Inc()
			ok = false
			continue
		}
		total += val
	}
	return total, ok
}

// isCurrencyEmpty detects the degenerate currency block sometimes
// emitted on appFees (no chainId, no address, no symbol). Without this
// guard such entries propagate to ok=false and tank coverage.
func isCurrencyEmpty(c RelayCurrency) bool {
	return c.ChainID == 0 && c.Address == "" && c.Symbol == ""
}

// resolvePrice maps a RelayCurrency to USD. Strategy:
//   1. stable peg by symbol → $1
//   2. native asset of a known chain → CG id from chainSpec
//   3. ERC-20 / SPL → PriceTokenUSD via (chainId, address)
//   4. bare symbol — last-ditch, rarely helps, kept for test fixtures
func resolvePrice(ctx context.Context, pricer Pricer, c RelayCurrency) (float64, bool) {
	if c.Symbol != "" && stablePegs[strings.ToUpper(c.Symbol)] {
		return 1.0, true
	}
	if isNativeCurrency(c) {
		cs, found := chainSpec(c.ChainID)
		if !found {
			return 0, false
		}
		return priceNative(ctx, pricer, cs)
	}
	// ERC-20 / SPL: contract-address lookup via Mobula (or CG fallback).
	if c.Address != "" {
		if v, ok := pricer.PriceTokenUSD(ctx, c.ChainID, c.Address, c.Symbol); ok {
			return v, true
		}
	}
	// Last-ditch: pricer's symbol-only lookup. Almost never resolves
	// real Relay swaps; kept so tests can author by symbol.
	if c.Symbol != "" {
		if v, ok := pricer.PriceUSD(ctx, "", c.Symbol); ok {
			return v, true
		}
	}
	return 0, false
}

// isNativeCurrency = "the chain's gas token". Relay marks these with
// the zero-address or an empty address; symbols also match the native
// of that chain. We're conservative — require the symbol to match.
func isNativeCurrency(c RelayCurrency) bool {
	cs, ok := chainSpec(c.ChainID)
	if !ok {
		return false
	}
	addrEmpty := c.Address == "" ||
		c.Address == "0x0000000000000000000000000000000000000000" ||
		strings.EqualFold(c.Address, "11111111111111111111111111111111") // Solana System Program
	return addrEmpty || strings.EqualFold(c.Symbol, cs.NativeSymbol)
}

// scaleAmount divides raw `amount` by 10^decimals using big.Float so
// 256-bit wei values don't lose precision before the float64 cast.
// Returns ok=false on parse error.
func scaleAmount(raw string, decimals int) (float64, bool) {
	if decimals < 0 {
		return 0, false
	}
	bi := new(big.Int)
	if _, ok := bi.SetString(strings.TrimSpace(raw), 10); !ok {
		return 0, false
	}
	bf := new(big.Float).SetInt(bi)
	div := new(big.Float).SetFloat64(pow10(decimals))
	bf.Quo(bf, div)
	v, _ := bf.Float64()
	return v, true
}

func pow10(n int) float64 {
	v := 1.0
	for i := 0; i < n; i++ {
		v *= 10.0
	}
	return v
}

// parseRelayTimestamp accepts RFC3339 with or without sub-second
// precision (Relay returns both).
func parseRelayTimestamp(s string) (int64, error) {
	if s == "" {
		return time.Now().Unix(), nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Unix(), nil
		}
	}
	return 0, fmt.Errorf("unrecognised timestamp %q", s)
}
