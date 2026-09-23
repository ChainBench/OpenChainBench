package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"time"
)

const jupUA = "OpenChainBench/1.0 (+https://openchainbench.com)"

func jupGet(client *http.Client, url string) ([]byte, string) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, "request_build"
	}
	req.Header.Set("User-Agent", jupUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "network"
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, "read"
	}
	if resp.StatusCode != 200 {
		// Jupiter answers 400 with an error body when no route exists;
		// the caller tells "no route" from a transport failure by status.
		return raw, fmt.Sprintf("http_%d", resp.StatusCode)
	}
	return raw, "ok"
}

type quoteResp struct {
	OutAmount string `json:"outAmount"`
	ErrorCode string `json:"errorCode"`
	Error     string `json:"error"`
}

// sellQuote asks Jupiter what `amountRaw` raw units of `mint` sell for in
// USDC (raw, 6 decimals). ok is false on any failure; noRoute is true
// when Jupiter answered that no route exists, as opposed to a transport
// or parse failure.
func sellQuote(client *http.Client, mint string, amountRaw *big.Int) (out float64, ok bool, noRoute bool) {
	url := fmt.Sprintf(
		"https://lite-api.jup.ag/swap/v1/quote?inputMint=%s&outputMint=%s&amount=%s&slippageBps=100",
		mint, usdcMint, amountRaw.String(),
	)
	raw, status := jupGet(client, url)
	if status == "http_429" {
		sourceCall.WithLabelValues("jup_quote", "http_429").Inc()
		time.Sleep(rateLimitPause)
		raw, status = jupGet(client, url)
	}
	var q quoteResp
	if raw != nil {
		_ = json.Unmarshal(raw, &q)
	}
	if status != "ok" {
		if q.ErrorCode == "NO_ROUTES_FOUND" || q.ErrorCode == "COULD_NOT_FIND_ANY_ROUTE" || q.ErrorCode == "TOKEN_NOT_TRADABLE" {
			sourceCall.WithLabelValues("jup_quote", "no_route").Inc()
			return 0, false, true
		}
		sourceCall.WithLabelValues("jup_quote", status).Inc()
		return 0, false, false
	}
	if q.OutAmount == "" {
		sourceCall.WithLabelValues("jup_quote", "parse").Inc()
		return 0, false, false
	}
	n, err := strconv.ParseFloat(q.OutAmount, 64)
	if err != nil || n <= 0 {
		sourceCall.WithLabelValues("jup_quote", "decode").Inc()
		return 0, false, false
	}
	sourceCall.WithLabelValues("jup_quote", "ok").Inc()
	return n / 1e6, true, false
}

// rawFor converts a UI amount of the asset into raw units.
func rawFor(a Asset, units float64) *big.Int {
	f := new(big.Float).Mul(big.NewFloat(units), big.NewFloat(math.Pow10(a.Decimals)))
	i, _ := f.Int(nil)
	if i.Sign() <= 0 {
		return big.NewInt(1)
	}
	return i
}

// depthResult is one tick's measurement for one asset.
type depthResult struct {
	PriceUSD  float64            // USD per UI unit from the $100 quote
	CostBps   map[string]float64 // per size suffix, present when quoted
	Fill100k  float64
	Route100k bool
	NoRoute   bool // Jupiter has no route at all for this mint
}

// measureDepth quotes the reference sale and each size for one routed
// asset. `lastPrice` (USD per UI unit, from the previous tick) sizes the
// $100 quote; a zero value costs one extra unit quote first.
func measureDepth(client *http.Client, a Asset, lastPrice float64) (depthResult, float64) {
	res := depthResult{CostBps: map[string]float64{}}
	price := lastPrice
	if price <= 0 {
		out, ok, noRoute := sellQuote(client, a.Mint, rawFor(a, 1))
		time.Sleep(quoteGap)
		if !ok {
			res.NoRoute = noRoute
			return res, 0
		}
		price = out
	}
	// Reference: $100 worth at the last known price.
	refRaw := rawFor(a, refUSD/price)
	refOut, ok, noRoute := sellQuote(client, a.Mint, refRaw)
	time.Sleep(quoteGap)
	if !ok {
		res.NoRoute = noRoute
		return res, 0
	}
	refPerRaw := refOut / bigToFloat(refRaw)
	res.PriceUSD = refPerRaw * math.Pow10(a.Decimals)
	for _, s := range sizes {
		raw := rawFor(a, s.USD/res.PriceUSD)
		out, ok, _ := sellQuote(client, a.Mint, raw)
		time.Sleep(quoteGap)
		if !ok {
			continue
		}
		perRaw := out / bigToFloat(raw)
		res.CostBps[s.Suffix] = (1 - perRaw/refPerRaw) * 10000
		if s.Suffix == "100k" {
			res.Fill100k = out
			res.Route100k = true
		}
	}
	return res, res.PriceUSD
}

// probeRoute confirms an unrouted asset still has no market: one unit
// sale quote. Returns true when Jupiter found a route after all (the
// operator should move the asset to the routed set).
func probeRoute(client *http.Client, a Asset) (routed bool, confirmed bool) {
	_, ok, noRoute := sellQuote(client, a.Mint, rawFor(a, 1))
	time.Sleep(quoteGap)
	if ok {
		return true, true
	}
	return false, noRoute
}

func bigToFloat(i *big.Int) float64 {
	f, _ := new(big.Float).SetInt(i).Float64()
	return f
}

// tokenSupply reads getTokenSupply for the mint: raw amount and UI
// amount. ok is false on any failure (a keyless endpoint refuses the
// call).
func tokenSupply(client *http.Client, mint string) (raw float64, ui float64, ok bool) {
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["` + mint + `"]}`)
	req, _ := http.NewRequest("POST", solanaRPC(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", jupUA)
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues("solana_rpc", "network").Inc()
		return 0, 0, false
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues("solana_rpc", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return 0, 0, false
	}
	var envel struct {
		Result struct {
			Value struct {
				Amount         string `json:"amount"`
				UIAmountString string `json:"uiAmountString"`
			} `json:"value"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &envel); err != nil || envel.Error != nil || envel.Result.Value.Amount == "" {
		sourceCall.WithLabelValues("solana_rpc", "rpc_error").Inc()
		return 0, 0, false
	}
	raw, err1 := strconv.ParseFloat(envel.Result.Value.Amount, 64)
	ui, err2 := strconv.ParseFloat(envel.Result.Value.UIAmountString, 64)
	if err1 != nil || err2 != nil {
		sourceCall.WithLabelValues("solana_rpc", "parse").Inc()
		return 0, 0, false
	}
	sourceCall.WithLabelValues("solana_rpc", "ok").Inc()
	return raw, ui, true
}
