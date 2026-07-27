package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// SocketBridge integrates the Socket Protocol v2 API (Bungee aggregator).
// Socket is a bridge aggregator: it routes across Across, Stargate, CCTP and
// others under the hood and returns the best output route.
//
// Auth: uses the public demo API key documented on socket.tech/developer.
// Set SOCKET_API_KEY env var to override with a registered key.
//
// Coverage: EVM-only. Base → Arbitrum, Arbitrum → Base are the supported
// corridors from this bench's route set. Solana is listed as chainId 900 but
// has sendingEnabled=false in Socket's chain list (verified 2026-07-27).
// HyperCore is not in Socket's chain registry.
type SocketBridge struct {
	client *http.Client
	apiKey string
}

func NewSocketBridge(apiKey string) *SocketBridge {
	key := apiKey
	if key == "" {
		key = "72a5b4b0-e727-48be-8aa1-5da9d62fe635" // Socket public demo key
	}
	return &SocketBridge{
		client: &http.Client{Timeout: 45 * time.Second},
		apiKey: key,
	}
}

func socketChainID(chain string) string {
	switch strings.ToLower(chain) {
	case "base":
		return "8453"
	case "arbitrum":
		return "42161"
	}
	return ""
}

type socketRoute struct {
	OutputValueInUsd    float64 `json:"outputValueInUsd"`
	InputValueInUsd     float64 `json:"inputValueInUsd"`
	TotalGasFeesInUsd   float64 `json:"totalGasFeesInUsd"`
	ServiceTime         int     `json:"serviceTime"`
	BridgeRoute struct {
		BridgeFeeAmount string `json:"bridgeFeeAmount"`
	} `json:"bridgeRoute"`
}

type socketQuoteResponse struct {
	Success bool `json:"success"`
	Result  struct {
		Routes []socketRoute `json:"routes"`
	} `json:"result"`
}

func (s *SocketBridge) getQuote(route TestRoute, rawAmount, fromChain, toChain, evmAddress string) (*socketRoute, time.Duration, error) {
	start := time.Now()

	params := url.Values{}
	params.Set("fromChainId", fromChain)
	params.Set("toChainId", toChain)
	params.Set("fromTokenAddress", route.FromToken)
	params.Set("toTokenAddress", route.ToToken)
	params.Set("fromAmount", rawAmount)
	params.Set("userAddress", evmAddress)
	params.Set("uniqueRoutesPerBridge", "true")
	params.Set("sort", "output")
	params.Set("singleTxOnly", "true")

	req, err := http.NewRequest(http.MethodGet, "https://api.socket.tech/v2/quote?"+params.Encode(), nil)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("socket request create: %w", err)
	}
	req.Header.Set("API-KEY", s.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("socket request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("socket %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}

	var out socketQuoteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("socket decode: %w", err)
	}
	if !out.Success || len(out.Result.Routes) == 0 {
		return nil, latency, fmt.Errorf("socket: no routes returned")
	}
	// Routes are sorted by output (best first) per the sort=output param.
	best := out.Result.Routes[0]
	return &best, latency, nil
}

func (s *SocketBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"socket", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	fromChain := socketChainID(route.FromChain)
	toChain := socketChainID(route.ToChain)
	if fromChain == "" || toChain == "" {
		return
	}

	// Honour SOCKET_API_KEY env override at call time (allows key rotation without
	// rebuilding the binary).
	apiKey := s.apiKey
	if k := strings.TrimSpace(os.Getenv("SOCKET_API_KEY")); k != "" {
		apiKey = k
	}
	s.apiKey = apiKey

	best, quoteLatency, err := s.getQuote(route, rawUnits, fromChain, toChain, evmAddress)
	if err != nil {
		log.Printf("[SOCKET][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, "quote_failed")...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Nanoseconds()) / 1e6)
	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	inUsd := best.InputValueInUsd
	outUsd := best.OutputValueInUsd
	gasUsd := best.TotalGasFeesInUsd
	costUsd := inUsd - outUsd
	if costUsd < 0 {
		costUsd = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}
	bridgeFeeUsd := costUsd - gasUsd
	if bridgeFeeUsd < 0 {
		bridgeFeeUsd = 0
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(bridgeFeeUsd)
	bridgeFeesPercent.WithLabelValues(labels...).Set((bridgeFeeUsd / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(0)
	bridgeGasUSD.WithLabelValues(labels...).Set(gasUsd)
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0)
	bridgeOutputUSD.WithLabelValues(labels...).Set(outUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(float64(best.ServiceTime) * 1000)

	log.Printf("[SOCKET][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %ds",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, best.ServiceTime)
}
