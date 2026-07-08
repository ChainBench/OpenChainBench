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

// NearIntentsBridge integrates Near Intents 1Click API (https://1click.chaindefuser.com)
// into the quote-loop. Solver auction model: the API polls a bus of market makers,
// returns the winning signed bid. Quote latency reflects bid arrival, not route search.
//
// Auth: Authorization: Bearer <JWT> if apiKey is set, otherwise anonymous (works
// but adds ~10 bps appFee and lower solver priority). The OpenAPI spec documents
// X-API-Key as preferred but it returned 401 in our tests; Bearer is the path
// that actually works for partner JWTs in 2026.
type NearIntentsBridge struct {
	client *http.Client
	apiKey string
}

func NewNearIntentsBridge(apiKey string) *NearIntentsBridge {
	return &NearIntentsBridge{
		// Server bus times out at 25s. Client gives a 5s margin for network round-trip.
		client: &http.Client{Timeout: 30 * time.Second},
		apiKey: strings.TrimSpace(apiKey),
	}
}

// nearIntentsAssetID maps a (chain, tokenAddress) tuple to the Near Intents
// assetId. The harness passes contract addresses (Solana mints + EVM
// contracts), NOT symbols, in route.FromToken / route.ToToken. Match by
// address. EVM addresses are case-insensitive; Solana mints case-sensitive.
//
// HyperCore is the only exception: the harness uses the symbol literal
// "USDC" for ToToken on HC and lets per-bridge translators map to the real
// HC perp address. Match that string directly.
//
// Returns ok=false when the tuple is not supported, so the caller skips
// the route cleanly without polluting bridge_errors_total with a
// quote_failed counter.
func nearIntentsAssetID(chain, tokenAddress string) (string, bool) {
	c := strings.ToLower(chain)
	addr := strings.ToLower(tokenAddress)
	switch c {
	case "solana":
		// SPL mint (case-sensitive)
		if tokenAddress == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" {
			return "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", true
		}
	case "base":
		// USDC on Base
		if addr == "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" {
			return "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", true
		}
	case "arbitrum":
		// USDC on Arbitrum (native, not USDC.e)
		if addr == "0xaf88d065e77c8cc2239327c5edb3a432268e5831" {
			return "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", true
		}
	case "hypercore":
		// Mobula harness uses the symbol literal "USDC" here, per the
		// per-bridge translator convention. Match that string directly.
		if tokenAddress == "USDC" {
			return "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f", true
		}
	}
	return "", false
}

type NearIntentsQuoteRequest struct {
	Dry                bool   `json:"dry"`
	SwapType           string `json:"swapType"`
	SlippageTolerance  int    `json:"slippageTolerance"`
	OriginAsset        string `json:"originAsset"`
	DepositType        string `json:"depositType"`
	DestinationAsset   string `json:"destinationAsset"`
	Amount             string `json:"amount"`
	Recipient          string `json:"recipient"`
	RecipientType      string `json:"recipientType"`
	RefundTo           string `json:"refundTo"`
	RefundType         string `json:"refundType"`
	Deadline           string `json:"deadline"`
	QuoteWaitingTimeMs int    `json:"quoteWaitingTimeMs"`
}

type NearIntentsQuoteResponse struct {
	Quote struct {
		AmountIn          string `json:"amountIn"`
		AmountInFormatted string `json:"amountInFormatted"`
		AmountInUsd       string `json:"amountInUsd"`
		AmountOut         string `json:"amountOut"`
		AmountOutFormatted string `json:"amountOutFormatted"`
		AmountOutUsd      string `json:"amountOutUsd"`
		// timeEstimate is the solver-reported settlement ETA in seconds.
		TimeEstimate float64 `json:"timeEstimate"`
	} `json:"quote"`
}

// solverTimeoutMarker is the prefix used by the 1Click coordinator when no
// market-maker submits a bid inside the auction window. It surfaces as HTTP
// 500 but is a normal "no quote available right now" outcome, not a bug we
// should tag as quote_failed.
const solverTimeoutMarker = "Failed to receive response within timeout"

func isSolverTimeout(body []byte) bool {
	return bytes.Contains(body, []byte(solverTimeoutMarker))
}

func (n *NearIntentsBridge) GetQuote(originAsset, destinationAsset, rawAmount, recipient, refundTo string) (*NearIntentsQuoteResponse, time.Duration, []byte, int, error) {
	start := time.Now()
	// Deadline must be a future ISO-8601 timestamp. The coordinator rejects
	// past deadlines outright; we pick 15 min to leave room for the bus loop.
	deadline := time.Now().UTC().Add(15 * time.Minute).Format("2006-01-02T15:04:05.000Z")

	body := NearIntentsQuoteRequest{
		Dry:                true,
		SwapType:           "EXACT_INPUT",
		SlippageTolerance:  100, // 1%
		OriginAsset:        originAsset,
		DepositType:        "ORIGIN_CHAIN",
		DestinationAsset:   destinationAsset,
		Amount:             rawAmount,
		Recipient:          recipient,
		RecipientType:      "DESTINATION_CHAIN",
		RefundTo:           refundTo,
		RefundType:         "ORIGIN_CHAIN",
		Deadline:           deadline,
		QuoteWaitingTimeMs: 3000,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, time.Since(start), nil, 0, fmt.Errorf("near-intents marshal: %w", err)
	}

	req, err := http.NewRequest("POST", "https://1click.chaindefuser.com/v0/quote", bytes.NewReader(payload))
	if err != nil {
		return nil, time.Since(start), nil, 0, fmt.Errorf("near-intents request build: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if n.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+n.apiKey)
	}

	resp, err := n.client.Do(req)
	if err != nil {
		return nil, time.Since(start), nil, 0, fmt.Errorf("near-intents request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, latency, raw, resp.StatusCode, fmt.Errorf("near-intents %d: %s", resp.StatusCode, truncateNI(string(raw), 300))
	}

	var out NearIntentsQuoteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, raw, resp.StatusCode, fmt.Errorf("near-intents decode: %w", err)
	}
	return &out, latency, raw, resp.StatusCode, nil
}

func (n *NearIntentsBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"near-intents", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// Resolve origin and destination assetIds. Anything we don't have a
	// mapping for is "unsupported_route" — skip silently so the bench stays
	// honest (no fake failures inflating the error counter).
	originAsset, originOK := nearIntentsAssetID(route.FromChain, route.FromToken)
	destAsset, destOK := nearIntentsAssetID(route.ToChain, route.ToToken)
	if !originOK || !destOK {
		return
	}

	// HyperCore is destination-only on Near Intents. The assetID map already
	// returns ok=false for HyperCore as source, but keep this guard explicit
	// so a future asset-id table extension can't quietly enable an unsupported
	// direction.
	if strings.EqualFold(route.FromChain, "HyperCore") {
		return
	}

	// Recipient and refundTo must be valid addresses for the respective chain
	// even in dry mode. Use the same wallets we use for live execution; the
	// coordinator accepts any well-formed address in dry mode.
	recipient := evmAddress
	refundTo := evmAddress
	if route.ToChain == "Solana" {
		recipient = solAddress
	}
	if route.FromChain == "Solana" {
		refundTo = solAddress
	}

	quote, quoteLatency, rawBody, httpStatus, err := n.GetQuote(originAsset, destAsset, rawUnits, recipient, refundTo)

	if err != nil {
		// Solver auction timeout is a normal "no bid" outcome, not a bug.
		// Distinguish in error_type so the page can decide later whether to
		// surface availability vs latency separately.
		errType := "quote_failed"
		if httpStatus == http.StatusInternalServerError && isSolverTimeout(rawBody) {
			errType = "solver_timeout"
		}
		log.Printf("[NEAR-INTENTS][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, errType)...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	// Latency is only meaningful for quotes that returned a usable response
	// (same rule as the other bridges). Fast 4xx rejections must not enter
	// the histogram or they skew the leader board.
	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Milliseconds()))
	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	inUsd, _ := strconv.ParseFloat(quote.Quote.AmountInUsd, 64)
	outUsd, _ := strconv.ParseFloat(quote.Quote.AmountOutUsd, 64)

	// Near Intents returns a single net amountOutUsd. The solver bid bakes in
	// gas, bridge fee, slippage and protocol cut. We expose the total as
	// bridge_cost_usd and leave the breakdown buckets at 0 to make it obvious
	// in the data that no per-component decomposition is available from this
	// provider.
	//
	// Destination delivery IS included in this number. A 2026-07 audit
	// flagged inUsd-outUsd as missing destination-chain gas; that is wrong.
	// The 1Click OpenAPI documents the quote's `withdrawFee` (destination
	// withdrawal fee, smallest unit of the destination asset) as "already
	// accounted for in the final amountOut result", and live dry quotes
	// (verified 2026-07-08, Base→Arb $300 USDC) return withdrawFee alongside
	// the netted amountOut. So inUsd-outUsd is the same all-in definition as
	// the other bridges (source fee + spread + destination delivery). Do NOT
	// add a separate destination gas term on top: it would double count.
	costUsd := inUsd - outUsd
	if costUsd < 0 {
		costUsd = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(0)
	bridgeFeesPercent.WithLabelValues(labels...).Set(0)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(0)
	bridgeGasUSD.WithLabelValues(labels...).Set(0)
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0)
	bridgeOutputUSD.WithLabelValues(labels...).Set(outUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(quote.Quote.TimeEstimate * 1000)

	log.Printf("[NEAR-INTENTS][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %.1fs",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, quote.Quote.TimeEstimate)
}

func truncateNI(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
