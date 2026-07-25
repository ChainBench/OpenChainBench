package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const (
	kyberUSDCBase      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	kyberUSDCBSC       = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	kyberUSDGRobinhood = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
)

// KyberSwapProvider hits aggregator-api.kyberswap.com for Base and BSC.
type KyberSwapProvider struct {
	client *http.Client
}

func NewKyberSwapProvider() *KyberSwapProvider {
	return &KyberSwapProvider{client: newWarmHTTPClient()}
}

func (p *KyberSwapProvider) Slug() string { return "kyberswap" }

func (p *KyberSwapProvider) SupportsChain(chain string) bool {
	return chain == "base" || chain == "bsc" || chain == "robinhood"
}

func (p *KyberSwapProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var slug, usdcAddr string
	switch token.Chain {
	case "base":
		slug = "base"
		usdcAddr = kyberUSDCBase
	case "bsc":
		slug = "bsc"
		usdcAddr = kyberUSDCBSC
	case "robinhood":
		slug = "robinhood"
		usdcAddr = kyberUSDGRobinhood
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	q := url.Values{}
	q.Set("tokenIn", usdcAddr)
	q.Set("tokenOut", token.Address)
	q.Set("amountIn", "1000000")
	q.Set("saveGas", "false")
	endpoint := fmt.Sprintf("https://aggregator-api.kyberswap.com/%s/api/v1/routes?%s", slug, q.Encode())

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	req.Header.Set("x-client-id", "openchainbench")

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[kyberswap] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[kyberswap] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		Data struct {
			RouteSummary struct {
				AmountOut string `json:"amountOut"`
			} `json:"routeSummary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[kyberswap] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.Data.RouteSummary.AmountOut != "" && r.Data.RouteSummary.AmountOut != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
