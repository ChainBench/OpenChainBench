package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type RelayBridge struct {
	client *http.Client
}

func NewRelayBridge() *RelayBridge {
	return &RelayBridge{client: &http.Client{Timeout: 45 * time.Second}}
}

// Chain ID mapping for Relay (uses custom numeric IDs)
func relayChainID(chain string) int64 {
	switch strings.ToLower(chain) {
	case "solana":
		return 792703809
	case "base":
		return 8453
	case "arbitrum":
		return 42161
	case "hypercore", "hyperliquid":
		return 1337
	}
	return 0
}

// relayDestToken translates the abstract ToToken from a TestRoute into the
// destination address Relay expects on that chain. HyperCore's USDC (Perps)
// uses the special zero address per Relay's /currencies/v2.
func relayDestToken(route TestRoute) string {
	if route.ToChain == "HyperCore" && strings.EqualFold(route.ToToken, "USDC") {
		return "0x00000000000000000000000000000000"
	}
	if route.ToChain == "Solana" {
		return route.ToToken // SPL mint, case-sensitive
	}
	return strings.ToLower(route.ToToken)
}

type RelayQuoteRequest struct {
	User                string `json:"user"`
	OriginChainID       int64  `json:"originChainId"`
	DestinationChainID  int64  `json:"destinationChainId"`
	OriginCurrency      string `json:"originCurrency"`
	DestinationCurrency string `json:"destinationCurrency"`
	Amount              string `json:"amount"`
	TradeType           string `json:"tradeType"`
	Recipient           string `json:"recipient"`
}

// RelaySolanaInstruction represents a Solana instruction from Relay
type RelaySolanaInstruction struct {
	Keys []struct {
		Pubkey     string `json:"pubkey"`
		IsSigner   bool   `json:"isSigner"`
		IsWritable bool   `json:"isWritable"`
	} `json:"keys"`
	ProgramId string `json:"programId"`
	Data      string `json:"data"` // hex-encoded instruction data
}

// RelayStepData can be EVM tx data or Solana instructions
type RelayStepData struct {
	// EVM fields
	To    string `json:"to"`
	Data  string `json:"data"`
	Value string `json:"value"`
	// Solana fields
	Instructions                 []RelaySolanaInstruction `json:"instructions"`
	AddressLookupTableAddresses  []string                 `json:"addressLookupTableAddresses"`
}

type RelayQuoteResponse struct {
	Details struct {
		CurrencyIn struct {
			AmountUsd string `json:"amountUsd"`
		} `json:"currencyIn"`
		CurrencyOut struct {
			AmountUsd string `json:"amountUsd"`
		} `json:"currencyOut"`
		TotalImpact struct {
			USD string `json:"usd"`
		} `json:"totalImpact"`
		TimeEstimate float64 `json:"timeEstimate"`
	} `json:"details"`
	Fees struct {
		Gas            struct{ AmountUsd string `json:"amountUsd"` } `json:"gas"`
		RelayerGas     struct{ AmountUsd string `json:"amountUsd"` } `json:"relayerGas"`
		RelayerService struct{ AmountUsd string `json:"amountUsd"` } `json:"relayerService"`
	} `json:"fees"`
	// Transaction steps for execution (EVM or Solana)
	Steps []struct {
		ID        string `json:"id"`
		RequestId string `json:"requestId"` // Request ID for status polling
		Items     []struct {
			Data  RelayStepData `json:"data"`
			Check struct {
				Endpoint string `json:"endpoint"` // Full polling URL
			} `json:"check"`
		} `json:"items"`
	} `json:"steps"`
}

func (r *RelayBridge) GetQuote(route TestRoute, rawAmount string, senderAddress, receiverAddress string) (*RelayQuoteResponse, time.Duration, error) {
	start := time.Now()

	// Currency case: Solana uses full token addresses, EVM uses lowercase symbols.
	// HyperCore needs special "0x00...0" for USDC perp.
	originCurrency := strings.ToLower(route.FromToken)
	destinationCurrency := relayDestToken(route)
	if route.IsSolanaSrc {
		originCurrency = route.FromToken
	}

	body := RelayQuoteRequest{
		User:                senderAddress,
		OriginChainID:       relayChainID(route.FromChain),
		DestinationChainID:  relayChainID(route.ToChain),
		OriginCurrency:      originCurrency,
		DestinationCurrency: destinationCurrency,
		Amount:              rawAmount,
		TradeType:           "EXACT_INPUT",
		Recipient:           receiverAddress,
	}
	bodyBytes, _ := json.Marshal(body)

	resp, err := r.client.Post("https://api.relay.link/quote", "application/json", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("relay request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("relay %d: %s", resp.StatusCode, string(raw))
	}

	// Debug: log raw response for Solana routes (gate behind env var to avoid
	// log flooding — every Solana quote dumps ~500 chars × 12 routes per 5 min).
	if route.IsSolanaSrc && os.Getenv("RELAY_DEBUG") == "true" {
		log.Printf("[relay-debug] Solana route response (first 500 chars): %s", truncate(string(raw), 500))
	}

	var out RelayQuoteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("relay decode: %w", err)
	}
	return &out, latency, nil
}

func (r *RelayBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"relay", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// Determine sender/receiver based on source/dest chains
	senderAddress := evmAddress
	receiverAddress := evmAddress
	if route.FromChain == "Solana" {
		senderAddress = solAddress
	}
	if route.ToChain == "Solana" {
		receiverAddress = solAddress
	}

	quote, quoteLatency, err := r.GetQuote(route, rawUnits, senderAddress, receiverAddress)

	if err != nil {
		log.Printf("[RELAY][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
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

	inUsd, _ := strconv.ParseFloat(quote.Details.CurrencyIn.AmountUsd, 64)
	outUsd, _ := strconv.ParseFloat(quote.Details.CurrencyOut.AmountUsd, 64)
	impact, _ := strconv.ParseFloat(quote.Details.TotalImpact.USD, 64)
	gasUsd, _ := strconv.ParseFloat(quote.Fees.Gas.AmountUsd, 64)
	relayerGas, _ := strconv.ParseFloat(quote.Fees.RelayerGas.AmountUsd, 64)
	relayerSvc, _ := strconv.ParseFloat(quote.Fees.RelayerService.AmountUsd, 64)

	// details.totalImpact.usd is signed from the user's perspective:
	// negative when the user loses USD value (the normal case, so -impact
	// is the positive cost), positive when the quoted output is worth MORE
	// than the input at oracle prices. The Base USDC → Arb USDT corridor
	// sits in the second case whenever USDT trades above USDC (verified
	// live 2026-07-08: totalImpact +$0.044 on $300), so this corridor's
	// cost clamps to 0 below. That zero is a genuine "no USD value lost"
	// quote under the all-in in-minus-out definition, not missing data.
	// The bench spec aggregates across corridors so a single clamped
	// corridor cannot render Relay's headline as a flat 0.000%.
	costUsd := -impact
	if costUsd == 0 {
		costUsd = (inUsd - outUsd)
	}
	if costUsd < 0 {
		costUsd = 0
	}
	bridgeFeesOnly := relayerSvc + relayerGas
	slippage := costUsd - bridgeFeesOnly - gasUsd
	if slippage < 0 {
		slippage = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(bridgeFeesOnly)
	bridgeFeesPercent.WithLabelValues(labels...).Set((bridgeFeesOnly / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(slippage)
	bridgeGasUSD.WithLabelValues(labels...).Set(gasUsd)
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0)
	bridgeOutputUSD.WithLabelValues(labels...).Set(outUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(float64(quote.Details.TimeEstimate * 1000))

	log.Printf("[RELAY][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %.1fs",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, quote.Details.TimeEstimate)
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
