package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// CoWProvider hits api.cow.fi/<network>/api/v1/quote.
// No-key. Wraps native sell-side (CoW Settlement only handles ERC20s).
// CoW is RFQ-style: the buyAmount returned is net-of-fee and reflects
// the price a solver is willing to fill, not a public mempool route.
// Does NOT support BSC.
type CoWProvider struct {
	region string
	client *http.Client
}

func NewCoWProvider(region string) *CoWProvider {
	return &CoWProvider{region: region, client: newWarmHTTPClient()}
}

func (p *CoWProvider) Slug() string { return "cow" }

func (p *CoWProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 100, 8453, 42161:
		return true
	}
	return false
}

// cowNetwork returns the URL slug CoW expects per chainId.
func cowNetwork(chainId int) string {
	switch chainId {
	case 1:
		return "mainnet"
	case 100:
		return "xdai"
	case 8453:
		return "base"
	case 42161:
		return "arbitrum_one"
	}
	return ""
}

func (p *CoWProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	net := cowNetwork(pair.ChainId)
	if net == "" {
		return 0, false, fmt.Errorf("unsupported chain")
	}
	// CoW Settlement only swaps ERC20s; wrap native on either side.
	tokenIn := pair.TokenIn
	if strings.EqualFold(tokenIn, NativeSentinel) {
		w, ok := wrappedNative[pair.ChainId]
		if !ok {
			return 0, false, fmt.Errorf("no wrapped-native for chain %d", pair.ChainId)
		}
		tokenIn = w
	}
	tokenOut := pair.TokenOut
	if strings.EqualFold(tokenOut, NativeSentinel) {
		w, ok := wrappedNative[pair.ChainId]
		if !ok {
			return 0, false, fmt.Errorf("no wrapped-native for chain %d", pair.ChainId)
		}
		tokenOut = w
	}

	body := map[string]any{
		"sellToken":           tokenIn,
		"buyToken":            tokenOut,
		"sellAmountBeforeFee": pair.AmountWei,
		"kind":                "sell",
		"from":                "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416",
		"receiver":            "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416",
	}
	bb, _ := json.Marshal(body)
	endpoint := fmt.Sprintf("https://api.cow.fi/%s/api/v1/quote", net)
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewBuffer(bb))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return 0, false, err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("429")
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("%d", resp.StatusCode)
	}
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		// CoW returns 400 + errorType=NoLiquidity / SellAmountDoesNotCoverFee
		// when it can't price — count those as no_route.
		if resp.StatusCode == 400 && bytes.Contains(rb, []byte("NoLiquidity")) {
			RecordNoRoute(p.Slug(), pair.Chain, p.region)
			return 0, false, fmt.Errorf("no_liquidity")
		}
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(rb))
	}
	var r struct {
		Quote struct {
			BuyAmount string `json:"buyAmount"`
		} `json:"quote"`
	}
	if err := json.Unmarshal(rb, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.Quote.BuyAmount == "" || r.Quote.BuyAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
