package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// BebopProvider hits api.bebop.xyz/router/<slug>/v1/quote.
// No-key but requires `source: openchainbench` header.
// RFQ: output is net-of-fees, gasless settlement for the taker.
// IMPORTANT: Bebop requires EIP-55 checksum on token addresses (lowercase USDT
// returns errorCode 101). Bebop also rejects native ETH on JAM/PMM executors,
// so we substitute the wrapped-native equivalent on the sell side.
type BebopProvider struct {
	region string
	client *http.Client
}

func NewBebopProvider(region string) *BebopProvider {
	return &BebopProvider{region: region, client: newWarmHTTPClient()}
}

func (p *BebopProvider) Slug() string { return "bebop" }

func (p *BebopProvider) Supports(chainId int) bool {
	// Per bebop docs: ethereum, base, arbitrum, bsc, polygon, optimism, taiko.
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161:
		return true
	}
	return false
}

// wrappedNative maps a chainId to its wrapped-native ERC20 (WETH, WBNB, etc.).
// Bebop's PMM executors don't accept native-ETH as a sell-token, so we wrap.
var wrappedNative = map[int]string{
	1:     "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
	10:    "0x4200000000000000000000000000000000000006", // WETH on Optimism
	56:    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
	137:   "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
	8453:  "0x4200000000000000000000000000000000000006", // WETH on Base
	42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
}

func (p *BebopProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	slug := ChainSlugFor(pair.ChainId)
	if slug == "" {
		return 0, false, fmt.Errorf("unsupported chain")
	}
	// Substitute native sentinel with the wrapped equivalent on sell side.
	tokenIn := pair.TokenIn
	if strings.EqualFold(tokenIn, NativeSentinel) {
		wrapped, ok := wrappedNative[pair.ChainId]
		if !ok {
			return 0, false, fmt.Errorf("no wrapped-native for chain %d", pair.ChainId)
		}
		tokenIn = wrapped
	}
	tokenOut := pair.TokenOut
	if strings.EqualFold(tokenOut, NativeSentinel) {
		wrapped, ok := wrappedNative[pair.ChainId]
		if !ok {
			return 0, false, fmt.Errorf("no wrapped-native for chain %d", pair.ChainId)
		}
		tokenOut = wrapped
	}

	q := url.Values{}
	q.Set("sell_tokens", tokenIn)
	q.Set("buy_tokens", tokenOut)
	q.Set("sell_amounts", pair.AmountWei)
	q.Set("taker_address", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := fmt.Sprintf("https://api.bebop.xyz/router/%s/v1/quote?%s", slug, q.Encode())

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("source", "openchainbench")

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
	body, _ := io.ReadAll(resp.Body)
	// Bebop returns 200 even on error — check the body shape.
	var r struct {
		BestPrice string `json:"bestPrice"`
		Routes    []struct {
			Type  string `json:"type"`
			Quote struct {
				BuyTokens map[string]struct {
					Amount string `json:"amount"`
				} `json:"buyTokens"`
			} `json:"quote"`
		} `json:"routes"`
		Errors map[string]any `json:"errors"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if len(r.Routes) == 0 {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_routes")
	}
	// Read amount from the first route's buyTokens map (the actual addr key
	// may differ in case from our request — Bebop checksums it).
	var amount string
	for _, v := range r.Routes[0].Quote.BuyTokens {
		amount = v.Amount
		break
	}
	if amount == "" || amount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("zero_out")
	}
	return ms, true, nil
}
