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

type LiFiBridge struct {
	client *http.Client
	apiKey string
}

func NewLiFiBridge(apiKey string) *LiFiBridge {
	return &LiFiBridge{
		client: &http.Client{Timeout: 45 * time.Second},
		apiKey: apiKey,
	}
}

// Chain ID mapping for Li.Fi
func lifiChainID(chain string) string {
	switch strings.ToLower(chain) {
	case "solana":
		return "1151111081099710"
	case "base":
		return "8453"
	case "arbitrum":
		return "42161"
	case "hypercore", "hyperliquid":
		return "1337"
	}
	return ""
}

// lifiDestToken translates the abstract ToToken from a TestRoute into the
// destination address LiFi expects. For HyperCore, LiFi accepts the Arb USDC
// address as a marker for "USDC" generally — we pass that.
func lifiDestToken(route TestRoute) string {
	if route.ToChain == "HyperCore" && strings.EqualFold(route.ToToken, "USDC") {
		return "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
	}
	return route.ToToken
}

type LiFiFeeCost struct {
	Name      string `json:"name"`
	AmountUSD string `json:"amountUSD"`
}

type LiFiQuoteResponse struct {
	Estimate struct {
		FromAmountUSD     string        `json:"fromAmountUSD"`
		ToAmountUSD       string        `json:"toAmountUSD"`
		ExecutionDuration float64       `json:"executionDuration"`
		FeeCosts          []LiFiFeeCost `json:"feeCosts"`
		ApprovalAddress   string        `json:"approvalAddress"` // Spender for ERC-20 approval
	} `json:"estimate"`
	Action struct {
		FromToken struct {
			Address string `json:"address"`
		} `json:"fromToken"`
		FromAmount string `json:"fromAmount"` // Raw amount for approval
	} `json:"action"`
	Tool    string `json:"tool"`
	Message string `json:"message,omitempty"`
	Code    int    `json:"code,omitempty"`
	// Transaction data for execution
	// For EVM source: uses To, Data, Value, GasLimit, ChainId
	// For Solana source: the base64 TX is in Data field (To/Value/GasLimit will be empty)
	TransactionRequest struct {
		To       string `json:"to"`
		Data     string `json:"data"`
		Value    string `json:"value"`
		GasLimit string `json:"gasLimit"`
		ChainId  int64  `json:"chainId"`
	} `json:"transactionRequest"`
}

func (l *LiFiBridge) GetQuote(route TestRoute, rawAmount string, senderAddress, receiverAddress string) (*LiFiQuoteResponse, time.Duration, error) {
	start := time.Now()

	url := fmt.Sprintf(
		"https://li.quest/v1/quote?fromChain=%s&toChain=%s&fromToken=%s&toToken=%s&fromAmount=%s&fromAddress=%s&toAddress=%s&order=FASTEST",
		lifiChainID(route.FromChain), lifiChainID(route.ToChain),
		route.FromToken, lifiDestToken(route),
		rawAmount, senderAddress, receiverAddress,
	)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("lifi request create: %w", err)
	}

	// Add API key header if available
	if l.apiKey != "" {
		req.Header.Set("x-lifi-api-key", l.apiKey)
	}

	resp, err := l.client.Do(req)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("lifi request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("lifi %d: %s", resp.StatusCode, string(raw))
	}

	var out LiFiQuoteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("lifi decode: %w", err)
	}
	if out.Message != "" {
		return nil, latency, fmt.Errorf("lifi error: %s", out.Message)
	}
	return &out, latency, nil
}

func (l *LiFiBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"lifi", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// Determine sender/receiver based on source/dest chains
	senderAddress := evmAddress
	receiverAddress := evmAddress
	if route.FromChain == "Solana" {
		senderAddress = solAddress
	}
	if route.ToChain == "Solana" {
		receiverAddress = solAddress
	}

	quote, quoteLatency, err := l.GetQuote(route, rawUnits, senderAddress, receiverAddress)

	if err != nil {
		log.Printf("[LIFI][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
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

	inUsd, _ := strconv.ParseFloat(quote.Estimate.FromAmountUSD, 64)
	outUsd, _ := strconv.ParseFloat(quote.Estimate.ToAmountUSD, 64)
	totalFeesUsd := 0.0
	for _, f := range quote.Estimate.FeeCosts {
		v, _ := strconv.ParseFloat(f.AmountUSD, 64)
		totalFeesUsd += v
	}

	// costUsd = fees + (input - output) if positive slippage
	costUsd := inUsd - outUsd
	if costUsd < 0 {
		// Oracle mismatch — use fees as baseline
		costUsd = totalFeesUsd
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}
	slippage := costUsd - totalFeesUsd
	if slippage < 0 {
		slippage = 0
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(totalFeesUsd)
	bridgeFeesPercent.WithLabelValues(labels...).Set((totalFeesUsd / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(slippage)
	bridgeGasUSD.WithLabelValues(labels...).Set(0) // bundled in feeCosts
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0)
	bridgeOutputUSD.WithLabelValues(labels...).Set(outUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(quote.Estimate.ExecutionDuration * 1000)

	log.Printf("[LIFI][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Tool: %s | Est: %.0fs",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, quote.Tool, quote.Estimate.ExecutionDuration)
}
