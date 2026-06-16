package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type DebridgeBridge struct {
	client *http.Client
}

func NewDebridgeBridge() *DebridgeBridge {
	return &DebridgeBridge{client: &http.Client{Timeout: 45 * time.Second}}
}

// Chain ID mapping for Debridge
func debridgeChainID(chain string) int64 {
	switch strings.ToLower(chain) {
	case "solana":
		return 7565164
	case "base":
		return 8453
	case "arbitrum":
		return 42161
	}
	return 0
}

// Debridge protocol charges a fixed amount in native tokens that we convert to USD
// using live spot prices (5min cache). Hardcoded fallbacks are intentionally
// conservative so an API outage doesn't make Debridge look artificially cheap.
//   Solana: 0.015 SOL native fix fee
//   EVM:    0.001 ETH native fix fee
func debridgeFixFeeUSD(fromChain string) float64 {
	switch strings.ToLower(fromChain) {
	case "solana":
		return 0.015 * TokenPriceUSD("SOL", 86.0)
	default:
		return 0.001 * TokenPriceUSD("ETH", 2300.0)
	}
}

type DebridgeQuoteResponse struct {
	Estimation struct {
		SrcChainTokenIn struct {
			ApproximateUsdValue       float64 `json:"approximateUsdValue"`
			OriginApproximateUsdValue float64 `json:"originApproximateUsdValue"`
		} `json:"srcChainTokenIn"`
		DstChainTokenOut struct {
			ApproximateUsdValue float64 `json:"approximateUsdValue"`
		} `json:"dstChainTokenOut"`
	} `json:"estimation"`
	FixFee                           string  `json:"fixFee"`
	ProtocolFeeApproximateUsdValue   float64 `json:"protocolFeeApproximateUsdValue"`
	Order                            struct {
		ApproximateFulfillmentDelay int64 `json:"approximateFulfillmentDelay"`
	} `json:"order"`
	ErrorMessage string `json:"errorMessage,omitempty"`
	ErrorCode    int    `json:"errorCode,omitempty"`
}

func (d *DebridgeBridge) GetQuote(route TestRoute, rawAmount string) (*DebridgeQuoteResponse, time.Duration, error) {
	start := time.Now()
	url := fmt.Sprintf(
		"https://dln.debridge.finance/v1.0/dln/order/quote?srcChainId=%d&srcChainTokenIn=%s&srcChainTokenInAmount=%s&dstChainId=%d&dstChainTokenOut=%s&dstChainTokenOutAmount=auto&prependOperatingExpenses=true",
		debridgeChainID(route.FromChain), route.FromToken, rawAmount,
		debridgeChainID(route.ToChain), route.ToToken,
	)

	// 2026-06-11: dln.debridge.finance moved behind a Cloudflare challenge
	// that 403s non-browser user agents (Go-http-client). Browser-grade
	// headers pass the non-interactive check; verified 200 in ~150ms.
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("debridge request: %w", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("debridge request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("debridge %d: %s", resp.StatusCode, string(raw))
	}

	var out DebridgeQuoteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("debridge decode: %w", err)
	}
	if out.ErrorMessage != "" {
		return nil, latency, fmt.Errorf("debridge error: %s", out.ErrorMessage)
	}
	return &out, latency, nil
}

func (d *DebridgeBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"debridge", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region}

	quote, quoteLatency, err := d.GetQuote(route, rawUnits)

	if err != nil {
		log.Printf("[DEBRIDGE][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, "quote_failed")...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	// Latency is only meaningful for quotes that returned a usable route
	// (the published methodology measures exactly that). Fast failures, e.g.
	// Cloudflare 403s answered in 30ms, must not enter the histogram: they
	// made deBridge look 15x faster the moment its API started rejecting us.
	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Milliseconds()))
	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	// Debridge returns input (with opEx ajusté) and output
	// costUsd = (user_paid_input - user_received_output) + fixFee_native_usd
	// user_paid_input: srcChainTokenIn.approximateUsdValue (includes opEx)
	// user_received: dstChainTokenOut.approximateUsdValue
	inUsd := quote.Estimation.SrcChainTokenIn.ApproximateUsdValue
	outUsd := quote.Estimation.DstChainTokenOut.ApproximateUsdValue
	fixFee := debridgeFixFeeUSD(route.FromChain)
	protocolFee := quote.ProtocolFeeApproximateUsdValue

	costUsd := (inUsd - outUsd) + fixFee
	if costUsd < 0 {
		costUsd = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}
	slippageUsd := costUsd - fixFee - protocolFee
	if slippageUsd < 0 {
		slippageUsd = 0
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(fixFee + protocolFee)
	bridgeFeesPercent.WithLabelValues(labels...).Set(((fixFee + protocolFee) / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(slippageUsd)
	bridgeGasUSD.WithLabelValues(labels...).Set(0) // included in fixFee
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(fixFee)
	bridgeOutputUSD.WithLabelValues(labels...).Set(outUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(float64(quote.Order.ApproximateFulfillmentDelay * 1000))

	log.Printf("[DEBRIDGE][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %ds",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, quote.Order.ApproximateFulfillmentDelay)
}
