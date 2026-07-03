package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

type MobulaBridge struct {
	apiKey string
	client *http.Client
}

type MobulaQuoteResponse struct {
	Data struct {
		EstimatedAmountOut    string `json:"estimatedAmountOut"`
		EstimatedAmountOutUsd string `json:"estimatedAmountOutUsd"`
		EstimatedTimeMs       int64  `json:"estimatedTimeMs"`
		MaxTradeUsd           int64  `json:"maxTradeUsd"`
		Fees                  struct {
			BridgeFeeBps int    `json:"bridgeFeeBps"`
			GasFeeUsd    string `json:"gasFeeUsd"`
			TotalFeeUsd  string `json:"totalFeeUsd"`
		} `json:"fees"`
		// Deposit transaction data (new API format)
		Deposit struct {
			Solana struct {
				Type         string `json:"type"`
				SerializedTx string `json:"serializedTx"` // Base64 Solana TX
			} `json:"solana"` // Solana TX for Solana sources
			EVM struct {
				To    string `json:"to"`
				Data  string `json:"data"`
				Value string `json:"value"`
			} `json:"evm"` // EVM TX for EVM sources
		} `json:"deposit"`
		// Legacy fields (kept for compatibility)
		SerializedTx string `json:"serializedTx"`
		// Steps array with approve + bridgeToken
		Steps []struct {
			Type        string `json:"type"` // "approve" or "bridgeToken"
			Description string `json:"description"`
			Tx          struct {
				To    string `json:"to"`
				Data  string `json:"data"`
				Value string `json:"value"`
			} `json:"tx"`
		} `json:"steps"`
	} `json:"data"`
}

type MobulaStatusResponse struct {
	Data struct {
		Status     string  `json:"status"` // "pending", "filled", "refunded", "failed"
		LatencyMs  int64   `json:"latencyMs"`
		FromTxHash string  `json:"fromTxHash"`
		ToTxHash   string  `json:"toTxHash"`
	} `json:"data"`
}

type MobulaRoutesResponse struct {
	Data struct {
		Routes []struct {
			OriginChainId      string `json:"originChainId"`
			DestinationChainId string `json:"destinationChainId"`
			EstimatedTimeMs    int64  `json:"estimatedTimeMs"`
			MaxTradeUsd        int64  `json:"maxTradeUsd"`
			FeeBps             int    `json:"feeBps"`
			SupportedTokens    string `json:"supportedTokens"`
		} `json:"routes"`
	} `json:"data"`
}

func NewMobulaBridge(apiKey string) *MobulaBridge {
	return &MobulaBridge{
		apiKey: apiKey,
		client: &http.Client{Timeout: 45 * time.Second},
	}
}

// APIKey returns the API key for use in status polling
func (m *MobulaBridge) APIKey() string {
	return m.apiKey
}

func (m *MobulaBridge) GetQuote(originChain, originToken, destChain, destToken, senderAddress, walletAddress string, amount float64) (*MobulaQuoteResponse, time.Duration, error) {
	start := time.Now()

	url := fmt.Sprintf(
		"https://api.mobula.io/api/2/bridge/quote?originChainId=%s&originToken=%s&destinationChainId=%s&destinationToken=%s&amount=%s&walletAddress=%s&apiKey=%s",
		originChain, originToken, destChain, destToken,
		strconv.FormatFloat(amount, 'f', -1, 64),
		walletAddress, m.apiKey,
	)
	if senderAddress != "" {
		url += "&senderAddress=" + senderAddress
	}

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	latency := time.Since(start)

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var quote MobulaQuoteResponse
	if err := json.Unmarshal(body, &quote); err != nil {
		return nil, latency, fmt.Errorf("failed to decode response: %w", err)
	}

	// API returns 200 with {"error": "..."} on business errors
	var errResp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &errResp); err == nil && errResp.Error != "" {
		return nil, latency, fmt.Errorf("API business error: %s", errResp.Error)
	}

	return &quote, latency, nil
}

func (m *MobulaBridge) GetStatus(txHash string) (*MobulaStatusResponse, error) {
	url := fmt.Sprintf("https://api.mobula.io/api/2/bridge/status/%s", txHash)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", m.apiKey)

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var status MobulaStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &status, nil
}

func (m *MobulaBridge) VerifyRoutes() (*MobulaRoutesResponse, error) {
	url := "https://api.mobula.io/api/2/bridge/routes"

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", m.apiKey)

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var routes MobulaRoutesResponse
	if err := json.NewDecoder(resp.Body).Decode(&routes); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &routes, nil
}

type TestRoute struct {
	Name         string
	FromChain    string  // Human-readable label (e.g. "Solana")
	FromChainAPI string  // API-specific id (e.g. "solana:solana")
	FromToken    string
	ToChain      string
	ToChainAPI   string
	ToToken      string
	Amounts      []float64 // token-native amounts (decimal)
	UsdAmounts   []float64 // same amounts expressed in USD (for labels)
	IsSolanaSrc  bool      // true if senderAddress is required
	WeeklyOnly   bool      // true if route should only run weekly (for meme tokens)
	QuoteOnly    bool      // true if route should NEVER be executed (quote loop only — for asymmetric or unsupported destinations like HC where we don't yet have on-chain fill plumbing)
}

func GetTestRoutes() []TestRoute {
	// USDC Triangle (self-balancing):
	// R1: Solana USDC → Base USDC
	// R2: Base USDC → Arbitrum USDT
	// R3: Arbitrum USDT → Solana USDC
	//
	// Meme Route (separate, weekly only):
	// R4: TRUMP (Solana) → BRETT (Base)
	//
	// TRUMP price is fetched dynamically via TokenPriceUSD (5min cache) so the R4
	// amounts always reflect the real token value — fixes the bug where a stale
	// hardcoded $2.87 made our $300-labelled quote actually send $266 worth.
	trumpPrice := TokenPriceUSD("TRUMP", 2.55) // current price ~$2.55, fallback if API unreachable
	trump5 := 5.0 / trumpPrice
	trump50 := 50.0 / trumpPrice
	trump300 := 300.0 / trumpPrice

	return []TestRoute{
		// R1: Solana USDC → Base USDC
		{
			Name:         "USDC_SOL_BASE",
			FromChain:    "Solana", FromChainAPI: "solana:solana",
			FromToken:    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			ToChain:      "Base", ToChainAPI: "evm:8453",
			ToToken:      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			Amounts:      []float64{5, 50, 300},
			UsdAmounts:   []float64{5, 50, 300},
			IsSolanaSrc:  true,
			WeeklyOnly:   false,
		},
		// R2: Base USDC → Arbitrum USDT
		{
			Name:         "USDC_BASE_USDT_ARB",
			FromChain:    "Base", FromChainAPI: "evm:8453",
			FromToken:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			ToChain:      "Arbitrum", ToChainAPI: "evm:42161",
			ToToken:      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
			Amounts:      []float64{5, 50, 300},
			UsdAmounts:   []float64{5, 50, 300},
			IsSolanaSrc:  false,
			WeeklyOnly:   false,
		},
		// R3: Arbitrum USDT → Solana USDC (completes the triangle)
		{
			Name:         "USDT_ARB_USDC_SOL",
			FromChain:    "Arbitrum", FromChainAPI: "evm:42161",
			FromToken:    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
			ToChain:      "Solana", ToChainAPI: "solana:solana",
			ToToken:      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			Amounts:      []float64{5, 50, 300},
			UsdAmounts:   []float64{5, 50, 300},
			IsSolanaSrc:  false,
			WeeklyOnly:   false,
		},
		// R4: TRUMP (Solana) → BRETT (Base) - one-way.
		// Amounts computed at startup from live TRUMP price (refreshed every 5min via
		// TokenPriceUSD cache). Execution stays weekly at $5 only.
		{
			Name:         "TRUMP_SOL_BRETT_BASE",
			FromChain:    "Solana", FromChainAPI: "solana:solana",
			FromToken:    "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
			ToChain:      "Base", ToChainAPI: "evm:8453",
			ToToken:      "0x532f27101965dd16442E59d40670FaF5eBB142E4",
			Amounts:      []float64{trump5, trump50, trump300},
			UsdAmounts:   []float64{5, 50, 300},
			IsSolanaSrc:  true,
			WeeklyOnly:   true,
		},
		// R5: Arbitrum USDC → HyperCore USDC (Hyperliquid perp account).
		// One-way deposit benchmark: HL is asymmetric (perp account credit,
		// withdraw goes through HL's L1 signed action, not handled here).
		// Phase 1 = quote-only — flagged QuoteOnly:true so GetTriangleRoutes()
		// excludes it from the $5/$50/$300 execution scheduler. Quote loop
		// still runs every 5min, so the dashboard gets latency/fees/cost data
		// for Mobula vs Relay vs LiFi on HC. Flip to false in Phase 2 once HL
		// balance reader + manual capital seed are in place.
		{
			Name:         "USDC_ARB_HYPERCORE",
			FromChain:    "Arbitrum", FromChainAPI: "evm:42161",
			FromToken:    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
			ToChain:      "HyperCore", ToChainAPI: "hl:mainnet",
			ToToken:      "USDC", // Mobula uses symbol; per-bridge translators map to provider-specific addr
			Amounts:      []float64{5, 50, 300},
			UsdAmounts:   []float64{5, 50, 300},
			IsSolanaSrc:  false,
			WeeklyOnly:   false,
			QuoteOnly:    true,
		},
	}
}

// GetTriangleRoutes returns only the routes that should run in the scheduled
// $5 / $50 / $300 execution cycles — i.e. the USDC triangle (R1, R2, R3).
// Excludes WeeklyOnly (R4 meme) and QuoteOnly (R5 HyperCore — quote loop only).
func GetTriangleRoutes() []TestRoute {
	routes := GetTestRoutes()
	var triangle []TestRoute
	for _, r := range routes {
		if r.WeeklyOnly || r.QuoteOnly {
			continue
		}
		triangle = append(triangle, r)
	}
	return triangle
}

// GetMemeRoutes returns only the meme routes (R4)
func GetMemeRoutes() []TestRoute {
	routes := GetTestRoutes()
	var meme []TestRoute
	for _, r := range routes {
		if r.WeeklyOnly {
			meme = append(meme, r)
		}
	}
	return meme
}

// TestRoute runs a quote against a given route, using amount (token-native) + amountUsd (for labels).
func (m *MobulaBridge) TestRoute(route TestRoute, amount, amountUsd float64, region, solAddress, evmAddress string) {
	amountStr := strconv.FormatFloat(amountUsd, 'f', 0, 64)
	labels := []string{"mobula", route.FromChain, route.ToChain, route.FromToken, route.ToToken, amountStr, region, route.ToChain}

	// senderAddress is the origin-chain signer/depositor the API needs
	// to build the EIP-712 deposit intent. Must be set for any origin,
	// not only Solana. Previously empty-defaulted on EVM origins, which
	// silently broke Arb -> Sol (no EVM address anywhere in the request,
	// API rejects with "senderAddress required" -> quote_failed loop).
	senderAddress := evmAddress
	walletAddress := evmAddress
	if route.IsSolanaSrc {
		senderAddress = solAddress
	}
	if route.ToChain == "Solana" {
		walletAddress = solAddress
	}

	quote, quoteLatency, err := m.GetQuote(
		route.FromChainAPI,
		route.FromToken,
		route.ToChainAPI,
		route.ToToken,
		senderAddress,
		walletAddress,
		amount,
	)


	if err != nil {
		log.Printf("[MOBULA][%s][%.0f USD] ❌ Quote failed: %v", route.Name, amountUsd, err)
		bridgeErrors.WithLabelValues(append(labels, "quote_failed")...).Inc()
		bridgeQuoteSuccess.WithLabelValues(labels...).Set(0)
		return
	}

	// Success-only: see debridge_bridge.go, failures must not enter the histogram.
	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(quoteLatency.Milliseconds()))

	bridgeQuoteSuccess.WithLabelValues(labels...).Set(1)

	outputUSD, _ := strconv.ParseFloat(quote.Data.EstimatedAmountOutUsd, 64)
	gasUSD, _ := strconv.ParseFloat(quote.Data.Fees.GasFeeUsd, 64)
	bridgeFeeUSD, _ := strconv.ParseFloat(quote.Data.Fees.TotalFeeUsd, 64)

	slippageUSD := amountUsd - outputUSD
	if slippageUSD < 0 {
		slippageUSD = 0
	}
	costUSD := bridgeFeeUSD + slippageUSD + gasUSD
	costPercent := 0.0
	if amountUsd > 0 {
		costPercent = (costUSD / amountUsd) * 100
	}

	bridgeFeesUSD.WithLabelValues(labels...).Set(bridgeFeeUSD)
	bridgeFeesPercent.WithLabelValues(labels...).Set((bridgeFeeUSD / amountUsd) * 100)
	bridgeCostUSD.WithLabelValues(labels...).Set(costUSD)
	bridgeCostPercent.WithLabelValues(labels...).Set(costPercent)
	bridgeSlippageUSD.WithLabelValues(labels...).Set(slippageUSD)
	bridgeGasUSD.WithLabelValues(labels...).Set(gasUSD)
	bridgeFixFeeUSD.WithLabelValues(labels...).Set(0) // Mobula has no fix fee
	bridgeOutputUSD.WithLabelValues(labels...).Set(outputUSD)
	bridgeEstimatedTimeMs.WithLabelValues(labels...).Set(float64(quote.Data.EstimatedTimeMs))

	log.Printf("[MOBULA][%s][%.0f USD] ✅ Quote: %dms | Cost: $%.4f (%.3f%%) | Est: %dms",
		route.Name,
		amountUsd,
		quoteLatency.Milliseconds(),
		costUSD,
		costPercent,
		quote.Data.EstimatedTimeMs,
	)
}
