package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"time"
)

// UniswapProvider hits trade-api.gateway.uniswap.org/v1/quote, the Trading
// API behind the Uniswap interface. Self-service free key from
// developers.uniswap.org/dashboard; the header is x-api-key, and neither
// Authorization: Bearer nor x-app-key authenticates (both return 401
// "Unauthenticated api key or session", verified 2026-10-19).
//
// Seventh among DEX aggregators by 30d volume, $3.7B across 10 chains
// (DefiLlama 2026-10-19), and the first name a reader notices missing from
// a swap-quote board.
//
// NATIVE-ETH SENTINEL: the zero address, like Odos and unlike the
// canonical 0xEeee form most of this harness uses.
//
// The response is unusually complete for our purposes: the output amount,
// the gas both in wei and in USD, and the block it quoted against. Only
// Nordstern and 0x also give all three, and the block is the only way to
// prove two quotes saw the same market.
type UniswapProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewUniswapProvider(region, apiKey string) *UniswapProvider {
	return &UniswapProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *UniswapProvider) Slug() string { return "uniswap" }

// Chains the Trading API serves that also appear in our basket. Robinhood
// Chain is not among them.
func (p *UniswapProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114:
		return true
	}
	return false
}

func (p *UniswapProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	body, _ := json.Marshal(map[string]any{
		"type":            "EXACT_INPUT",
		"tokenInChainId":  pair.ChainId,
		"tokenOutChainId": pair.ChainId,
		"tokenIn":         mapNative(pair.TokenIn, ZeroAddress),
		"tokenOut":        mapNative(pair.TokenOut, ZeroAddress),
		"amount":          pair.AmountWei,
		// A quote is swapper-scoped. The address is the same burner the
		// other adapters use, so no provider sees a different caller.
		"swapper": "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416",
	})

	req, _ := http.NewRequestWithContext(ctx, "POST",
		"https://trade-api.gateway.uniswap.org/v1/quote", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.apiKey)

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return failed(), err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("429")
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("%d", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return failed(), fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(raw))
	}

	var r struct {
		Routing string `json:"routing"`
		Quote   struct {
			Output struct {
				Amount string `json:"amount"`
			} `json:"output"`
			BlockNumber string `json:"blockNumber"`
			// PortionBips is the interface fee when one is applied. Our
			// request sets no portion, so it is normally absent; parsed
			// anyway so a fee introduced later is published rather than
			// silently absorbed into the output.
			PortionBips *int `json:"portionBips"`
			// gasUseEstimate is the expected burn. maxFeePerGas is a
			// EIP-1559 ceiling rather than the price paid, but it is the
			// assumption Uniswap itself prices with: its own gasFee of
			// 1,652,639,802,817 wei over 194,000 units implies 8,519,792,
			// which is maxFeePerGas. Recorded as the provider's assumption,
			// which is all this series claims to be.
			GasUseEstimate any `json:"gasUseEstimate"`
			MaxFeePerGas   any `json:"maxFeePerGas"`
		} `json:"quote"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	out := r.Quote.Output.Amount
	if out == "" || out == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}
	if _, ok := new(big.Float).SetString(out); !ok {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), fmt.Errorf("unparseable output %q", snippet([]byte(out)))
	}

	quote := okQuote(ms, out)
	quote.GasUnits = uintAny(r.Quote.GasUseEstimate)
	quote.GasPriceWei = numAny(r.Quote.MaxFeePerGas)
	if n, err := strconv.ParseUint(r.Quote.BlockNumber, 10, 64); err == nil {
		quote.Block = n
	}
	if r.Quote.PortionBips != nil {
		quote.FeeBps = float64(*r.Quote.PortionBips)
	}
	return quote, nil
}
