package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// MayanBridge integrates the Mayan Finance v3 quote API. Mayan is a Solana-
// native intent layer that routes via Wormhole (Swift fast path ~2-5s,
// MCTP Circle-based ~20s). Public REST, keyless (verified live 2026-07-27,
// though ROUTE_NOT_FOUND may be transient on some corridors — the harness
// records failures as quote_failed and excludes them from latency aggregates
// so any outage window is surfaced as a drop in success rate, not a latency
// floor).
//
// Coverage: any corridor involving Solana. EVM↔EVM routes are outside Mayan's
// product scope and return early without emitting metrics (honesty convention
// shared with Across / Near Intents).
//
// Chain name mapping follows Mayan's API conventions (lowercase, no numbers).
type MayanBridge struct {
	client *http.Client
}

func NewMayanBridge() *MayanBridge {
	return &MayanBridge{client: &http.Client{Timeout: 45 * time.Second}}
}

func mayanChainName(chain string) string {
	switch strings.ToLower(chain) {
	case "solana":
		return "solana"
	case "base":
		return "base"
	case "arbitrum":
		return "arbitrum"
	}
	return ""
}

// mayanHasSolana returns true when at least one end of the route is Solana.
// Mayan's value prop is Solana-EVM bridging; pure EVM pairs are out of scope.
func mayanHasSolana(route TestRoute) bool {
	return strings.EqualFold(route.FromChain, "Solana") || strings.EqualFold(route.ToChain, "Solana")
}

type mayanQuoteResponse struct {
	// Happy path: array of route options
	Routes []struct {
		ExpectedAmountOut float64 `json:"expectedAmountOut"`
		MiminumAmountOut  float64 `json:"minimumAmountOut"`
		Price             float64 `json:"price"`
		PriceImpact       float64 `json:"priceImpact"`
		SwapFee           float64 `json:"swapFee"`
		RedeemRelayerFee  float64 `json:"redeemRelayerFee"`
		SendRelayerFee    float64 `json:"sendRelayerFee"`
		ClientRelayerFee  float64 `json:"clientRelayerFee"`
		Eta               float64 `json:"eta"`
		Type              string  `json:"type"` // "SWIFT" | "MCTP" | "WH"
	} `json:"routes"`
	// Error shape
	Code    string `json:"code,omitempty"`
	Message string `json:"msg,omitempty"`
}

func (m *MayanBridge) getQuote(route TestRoute, amountUsd float64) (*mayanQuoteResponse, time.Duration, error) {
	start := time.Now()

	params := url.Values{}
	// Mayan takes the human-readable amount in USD equivalent, not raw token units.
	params.Set("amount", strconv.FormatFloat(amountUsd, 'f', 2, 64))
	params.Set("fromToken", route.FromToken)
	params.Set("toToken", route.ToToken)
	params.Set("fromChain", mayanChainName(route.FromChain))
	params.Set("toChain", mayanChainName(route.ToChain))
	params.Set("slippage", "0.5")
	params.Set("sdkVersion", "15") // latest as of 2026-07-27

	req, err := http.NewRequest(http.MethodGet, "https://price-api.mayan.finance/v3/quote?"+params.Encode(), nil)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("mayan request create: %w", err)
	}
	req.Header.Set("User-Agent", "OpenChainBench-harness/1.0")
	req.Header.Set("Accept", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("mayan request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("mayan %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}

	var out mayanQuoteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("mayan decode: %w", err)
	}
	if out.Code != "" {
		return nil, latency, fmt.Errorf("mayan %s: %s", out.Code, out.Message)
	}
	if len(out.Routes) == 0 {
		return nil, latency, fmt.Errorf("mayan: no routes returned")
	}
	return &out, latency, nil
}

func (m *MayanBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"mayan", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// Mayan is Solana-EVM only. Skip pure-EVM corridors and HyperCore.
	if !mayanHasSolana(route) {
		return
	}
	if mayanChainName(route.FromChain) == "" || mayanChainName(route.ToChain) == "" {
		return
	}

	result, quoteLatency, err := m.getQuote(route, amountUsd)
	if err != nil {
		log.Printf("[MAYAN][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, "quote_failed")...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Nanoseconds()) / 1e6)
	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	// Use the best (first) route. Mayan sorts by output amount descending.
	best := result.Routes[0]

	// Mayan quotes output in destination token units (USDC = 6 decimals).
	// expectedAmountOut is in token base units; normalise to USD (1 USDC = $1).
	outUsd := best.ExpectedAmountOut / 1e6

	// All-in cost: relayer fees + swap fee. Mayan does not expose a single
	// USD total; we reconstruct from the fee fields (all in source token units,
	// 6-decimal USDC normalised to USD here).
	bridgeFeeUsd := (best.RedeemRelayerFee + best.SendRelayerFee + best.ClientRelayerFee) / 1e6
	swapFeeUsd := best.SwapFee / 1e6
	gasUsd := 0.0 // gas is rolled into relayer fees for Mayan
	costUsd := amountUsd - outUsd
	if costUsd < 0 {
		costUsd = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}
	slippage := swapFeeUsd
	if slippage < 0 {
		slippage = 0
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(bridgeFeeUsd)
	bridgeFeesPercent.WithLabelValues(labels...).Set((bridgeFeeUsd / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(slippage)
	bridgeGasUSD.WithLabelValues(labels...).Set(gasUsd)
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0)
	bridgeOutputUSD.WithLabelValues(labels...).Set(outUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(best.Eta * 1000)

	log.Printf("[MAYAN][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Type: %s | Est: %.0fs",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, best.Type, best.Eta)
}
