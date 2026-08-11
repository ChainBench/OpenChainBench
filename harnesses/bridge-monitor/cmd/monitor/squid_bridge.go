package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SquidBridge integrates the Squid Router v2 API (Axelar-powered cross-chain
// routing). Public REST with a free integrator ID, no registration required
// for the public `squid-swap-widget` key (verified live 2026-07-27).
//
// Coverage: EVM-only. Base → Arbitrum and Arbitrum → Base are supported.
// Solana as origin chain returns a server-side 500 ("Cannot read properties
// of undefined (reading 'isEvmos')") — Squid v2 Solana support is broken at
// the API level as of 2026-07-27. HyperCore is not in Squid's chain list.
// Both cases return early without emitting metrics.
//
// The SQUID_INTEGRATOR_ID env var overrides the default public key, allowing
// a registered ID to be swapped in without a code change.
type SquidBridge struct {
	client       *http.Client
	integratorID string
}

func NewSquidBridge(integratorID string) *SquidBridge {
	id := integratorID
	if id == "" {
		id = "squid-swap-widget"
	}
	return &SquidBridge{
		client:       &http.Client{Timeout: 45 * time.Second},
		integratorID: id,
	}
}

func squidChainID(chain string) string {
	switch strings.ToLower(chain) {
	case "base":
		return "8453"
	case "arbitrum":
		return "42161"
	}
	return ""
}

type squidRouteRequest struct {
	FromChain   string `json:"fromChain"`
	ToChain     string `json:"toChain"`
	FromToken   string `json:"fromToken"`
	ToToken     string `json:"toToken"`
	FromAmount  string `json:"fromAmount"`
	FromAddress string `json:"fromAddress"`
	ToAddress   string `json:"toAddress"`
	Slippage    int    `json:"slippage"`
}

type squidFeeCost struct {
	Name      string `json:"name"`
	AmountUsd string `json:"amountUsd"`
}

type squidGasCost struct {
	Type      string `json:"type"`
	AmountUsd string `json:"amountUsd"`
}

type squidRouteResponse struct {
	Route struct {
		Estimate struct {
			FromAmountUSD         string         `json:"fromAmountUSD"`
			ToAmountUSD           string         `json:"toAmountUSD"`
			FeeCosts              []squidFeeCost `json:"feeCosts"`
			GasCosts              []squidGasCost `json:"gasCosts"`
			EstimatedRouteDuration int            `json:"estimatedRouteDuration"`
		} `json:"estimate"`
	} `json:"route"`
	// Error shape
	Message string `json:"message,omitempty"`
}

func (s *SquidBridge) getQuote(route TestRoute, rawAmount, evmAddress string) (*squidRouteResponse, time.Duration, error) {
	start := time.Now()

	body := squidRouteRequest{
		FromChain:   squidChainID(route.FromChain),
		ToChain:     squidChainID(route.ToChain),
		FromToken:   route.FromToken,
		ToToken:     route.ToToken,
		FromAmount:  rawAmount,
		FromAddress: evmAddress,
		ToAddress:   evmAddress,
		Slippage:    1,
	}
	bodyBytes, _ := json.Marshal(body)

	req, err := http.NewRequest(http.MethodPost, "https://apiplus.squidrouter.com/v2/route", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("squid request create: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-integrator-id", s.integratorID)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("squid request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("squid %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}

	var out squidRouteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("squid decode: %w", err)
	}
	if out.Message != "" {
		return nil, latency, fmt.Errorf("squid error: %s", out.Message)
	}
	if out.Route.Estimate.ToAmountUSD == "" {
		return nil, latency, fmt.Errorf("squid: empty toAmountUSD in response")
	}
	return &out, latency, nil
}

func (s *SquidBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"squid", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// Squid v2: EVM chains only. Solana source returns 500 server error.
	// HyperCore is not in Squid's chain list.
	if squidChainID(route.FromChain) == "" || squidChainID(route.ToChain) == "" {
		return
	}

	quote, quoteLatency, err := s.getQuote(route, rawUnits, evmAddress)
	if err != nil {
		log.Printf("[SQUID][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, "quote_failed")...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Nanoseconds()) / 1e6)
	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	inUsd, _ := strconv.ParseFloat(quote.Route.Estimate.FromAmountUSD, 64)
	outUsd, _ := strconv.ParseFloat(quote.Route.Estimate.ToAmountUSD, 64)

	// Sum all protocol fee costs (relayer gas receiver, etc.)
	var bridgeFeeUsd float64
	for _, f := range quote.Route.Estimate.FeeCosts {
		v, _ := strconv.ParseFloat(f.AmountUsd, 64)
		bridgeFeeUsd += v
	}
	// Sum execution gas costs
	var gasUsd float64
	for _, g := range quote.Route.Estimate.GasCosts {
		v, _ := strconv.ParseFloat(g.AmountUsd, 64)
		gasUsd += v
	}

	// Prefer fromAmountUSD - toAmountUSD as the all-in cost (captures spread + fees + gas
	// as netted by the router). Fall back to explicit fee+gas sum when the USD amounts
	// are identical (e.g. stable→stable where spot prices cancel out).
	diffUsd := inUsd - outUsd
	var costUsd float64
	if diffUsd > 0.001 {
		costUsd = diffUsd
	} else {
		costUsd = bridgeFeeUsd + gasUsd
	}
	if costUsd < 0 {
		costUsd = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}
	slippage := diffUsd - bridgeFeeUsd - gasUsd
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
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(float64(quote.Route.Estimate.EstimatedRouteDuration) * 1000)

	log.Printf("[SQUID][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %ds",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, quote.Route.Estimate.EstimatedRouteDuration)
}
