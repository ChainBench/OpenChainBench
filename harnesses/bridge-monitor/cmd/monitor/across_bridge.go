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

// AcrossBridge integrates the Across Swap API (app.across.to/api/swap/approval)
// into the quote loop. Public REST, keyless (verified live 2026-07-08).
//
// Why the Swap API and not /suggested-fees: two of this bench's corridors are
// cross-asset (Base USDC → Arb USDT, Arb USDT → Sol USDC) and suggested-fees
// only quotes same-asset deposits. The swap endpoint quotes both shapes with
// one response schema and provider-computed USD fee totals, so every corridor
// uses the same all-in definition. Solana is a first-class origin/destination
// (SVM spoke pool, chainId 34268394551451), verified live both directions.
//
// HyperCore is skipped: Across's chainId 999 destination is HyperEVM, where
// delivery is an ERC-20 transfer on the EVM chain, NOT a HyperCore perp
// account credit like the other providers quote on the Arb → HyperCore
// corridor. Publishing it would compare different deliverables.
//
// ── Providers evaluated for this bench and dropped ──
//
// Stargate: the keyless stargate.finance/api/v1/quotes endpoint is deprecated
// (returns a deprecation notice pointing at transfer.layerzero-api.com), and
// the replacement VT API answers {"error":"Unauthorized"} without an API key
// (verified 2026-07-08). The remaining keyless path is an on-chain
// quoteOFT/quoteSend eth_call, but Stargate pools are same-asset only and
// EVM-only for that call path, which matches zero of this bench's corridors:
// the EVM legs are cross-asset (USDC→USDT / USDT→USDC) and the same-asset
// legs start or end on Solana. Building SVM quote plumbing for a provider
// that still could not quote any corridor is disproportionate, so Stargate
// is excluded rather than misrepresented.
//
// CCTP: Circle's burn/mint has no quote API that returns a delivered amount.
// Standard transfers mint exactly 1:1 and the entire cost is source plus
// destination gas the user pays out of band; CCTP v2 fast transfers expose a
// bps fee (iris-api.circle.com/v2/burn/USDC/fees) but still no delivery
// quote. Producing a row would require us to estimate gas ourselves, which
// is a different definition from the quoted-USD-in minus quoted-USD-delivered
// number every other row publishes. CCTP is also USDC-only, so only one of
// the four corridors is even in scope. Excluded by design; disclosed in the
// bench spec methodology.
type AcrossBridge struct {
	client *http.Client
}

func NewAcrossBridge() *AcrossBridge {
	return &AcrossBridge{client: &http.Client{Timeout: 45 * time.Second}}
}

// Chain ID mapping for Across (Solana uses Across's SVM chain id).
func acrossChainID(chain string) int64 {
	switch strings.ToLower(chain) {
	case "solana":
		return 34268394551451
	case "base":
		return 8453
	case "arbitrum":
		return 42161
	}
	return 0
}

// acrossSupportedToken restricts Across to the stablecoin corridors this
// bench sweeps (Sol/Base/Arb USDC + Arb USDT). The TRUMP → BRETT calibration
// route is deliberately not quoted: the Swap API would wrap two DEX swaps
// around the bridge leg, and the route is excluded from the bench queries
// anyway (from_token filter), so quoting it only burns rate budget.
func acrossSupportedToken(chain, token string) bool {
	switch strings.ToLower(chain) {
	case "solana":
		return token == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC mint, case-sensitive
	case "base":
		return strings.EqualFold(token, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") // USDC
	case "arbitrum":
		return strings.EqualFold(token, "0xaf88d065e77c8cc2239327c5edb3a432268e5831") || // USDC
			strings.EqualFold(token, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9") // USDT
	}
	return false
}

// AcrossFeeUSD is one USD-denominated fee bucket in the Swap API response.
// amountUsd is a JSON string (decimal), same as LiFi/Relay.
type AcrossFeeUSD struct {
	AmountUsd string `json:"amountUsd"`
}

type AcrossSwapResponse struct {
	Fees struct {
		Total struct {
			AmountUsd string `json:"amountUsd"`
			Details   struct {
				Bridge struct {
					AmountUsd string `json:"amountUsd"`
					Details   struct {
						DestinationGas AcrossFeeUSD `json:"destinationGas"`
					} `json:"details"`
				} `json:"bridge"`
			} `json:"details"`
		} `json:"total"`
	} `json:"fees"`
	InputAmount          string  `json:"inputAmount"`
	ExpectedOutputAmount string  `json:"expectedOutputAmount"`
	ExpectedFillTime     float64 `json:"expectedFillTime"`
	// Error shape (non-200): {"message": "..."} or {"error": "..."}
	Message string `json:"message,omitempty"`
	ErrorID string `json:"error,omitempty"`
}

func (a *AcrossBridge) GetQuote(route TestRoute, rawAmount, depositor, recipient string) (*AcrossSwapResponse, time.Duration, error) {
	start := time.Now()

	url := fmt.Sprintf(
		"https://app.across.to/api/swap/approval?tradeType=exactInput&amount=%s&inputToken=%s&originChainId=%d&outputToken=%s&destinationChainId=%d&depositor=%s&recipient=%s",
		rawAmount, route.FromToken, acrossChainID(route.FromChain),
		route.ToToken, acrossChainID(route.ToChain), depositor, recipient,
	)

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("across request create: %w", err)
	}
	req.Header.Set("User-Agent", "OpenChainBench-harness/1.0")
	req.Header.Set("Accept", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, time.Since(start), fmt.Errorf("across request: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("across %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}

	var out AcrossSwapResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, latency, fmt.Errorf("across decode: %w", err)
	}
	if out.Message != "" || out.ErrorID != "" {
		return nil, latency, fmt.Errorf("across error: %s %s", out.ErrorID, out.Message)
	}
	return &out, latency, nil
}

func (a *AcrossBridge) TestRoute(route TestRoute, amount, amountUsd float64, rawUnits string, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"across", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// Unsupported corridors (HyperCore destination, non-stable calibration
	// tokens) return early WITHOUT emitting metrics, same convention as
	// Near Intents, so coverage asymmetry never shows up as fake failures.
	if acrossChainID(route.FromChain) == 0 || acrossChainID(route.ToChain) == 0 {
		return
	}
	if !acrossSupportedToken(route.FromChain, route.FromToken) || !acrossSupportedToken(route.ToChain, route.ToToken) {
		return
	}

	depositor := evmAddress
	recipient := evmAddress
	if route.FromChain == "Solana" {
		depositor = solAddress
	}
	if route.ToChain == "Solana" {
		recipient = solAddress
	}

	quote, quoteLatency, err := a.GetQuote(route, rawUnits, depositor, recipient)

	if err != nil {
		log.Printf("[ACROSS][%s][%.0f USD] ❌ %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, "quote_failed")...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	// Latency is only meaningful for quotes that returned a usable route
	// (same rule as the other bridges). Fast 4xx rejections must not enter
	// the histogram or they skew the leaderboard.
	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Milliseconds()))
	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	// fees.total.amountUsd is Across's own USD valuation of input value minus
	// expected delivered value: relayer capital + LP fee + destination gas +
	// any origin/destination swap impact (signed) + app fee. That is exactly
	// the quoted-in minus quoted-delivered definition the other rows publish.
	costUsd, _ := strconv.ParseFloat(quote.Fees.Total.AmountUsd, 64)
	if costUsd < 0 {
		// Swap impact in the user's favour (e.g. USDT above peg) can push the
		// total negative. Same clamp as the other providers: no USD value lost.
		costUsd = 0
	}
	costPct := 0.0
	if amountUsd > 0 {
		costPct = (costUsd / amountUsd) * 100
	}

	bridgeFeeUsd, _ := strconv.ParseFloat(quote.Fees.Total.Details.Bridge.AmountUsd, 64)
	gasUsd, _ := strconv.ParseFloat(quote.Fees.Total.Details.Bridge.Details.DestinationGas.AmountUsd, 64)
	slippage := costUsd - bridgeFeeUsd
	if slippage < 0 {
		slippage = 0
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(bridgeFeeUsd)
	bridgeFeesPercent.WithLabelValues(labels...).Set((bridgeFeeUsd / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUsd)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPct)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(slippage)
	bridgeGasUSD.WithLabelValues(labels...).Set(gasUsd) // destination fill gas, already inside bridge fee
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0)
	bridgeOutputUSD.WithLabelValues(labels...).Set(amountUsd - costUsd)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(quote.ExpectedFillTime * 1000)

	log.Printf("[ACROSS][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %.0fs",
		route.Name, amountUsd, quoteLatency.Milliseconds(),
		costUsd, costPct, quote.ExpectedFillTime)
}
