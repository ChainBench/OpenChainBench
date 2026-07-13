package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Jupiter lite-api legs. Two swap quotes per symbol per tick (sell one
// share, buy one share worth of USDC back), spaced quoteGap apart to
// stay far under the lite tier's 60 req/min. The mid of the two
// implied prices is the executable peg price. One batched price/v3
// call per tick provides the ScaledUiAmount multiplier per mint.

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
		return nil, fmt.Sprintf("http_%d", resp.StatusCode)
	}
	return raw, "ok"
}

// fetchMultipliers reads price/v3 for every mint in one call and
// derives the ScaledUiAmount multiplier as usdPrice / usdPricePrescaled
// (1.0 when the mint carries no scaling config).
func fetchMultipliers(client *http.Client) map[string]float64 {
	ids := make([]string, 0, len(assets))
	for _, a := range assets {
		ids = append(ids, a.Mint)
	}
	raw, status := jupGet(client, "https://lite-api.jup.ag/price/v3?ids="+strings.Join(ids, ","))
	if raw == nil {
		tspSourceCall.WithLabelValues("jup_price", status).Inc()
		return nil
	}
	var flat map[string]struct {
		USDPrice          float64 `json:"usdPrice"`
		USDPricePrescaled float64 `json:"usdPricePrescaled"`
	}
	if err := json.Unmarshal(raw, &flat); err != nil {
		tspSourceCall.WithLabelValues("jup_price", "parse").Inc()
		return nil
	}
	out := make(map[string]float64, len(flat))
	for mint, v := range flat {
		m := 1.0
		if v.USDPricePrescaled > 0 && v.USDPrice > 0 {
			m = v.USDPrice / v.USDPricePrescaled
		}
		out[mint] = m
	}
	tspSourceCall.WithLabelValues("jup_price", "ok").Inc()
	return out
}

type quoteResp struct {
	OutAmount string `json:"outAmount"`
}

func quoteOut(client *http.Client, inMint, outMint string, amount int64) (float64, bool) {
	url := fmt.Sprintf(
		"https://lite-api.jup.ag/swap/v1/quote?inputMint=%s&outputMint=%s&amount=%d&slippageBps=100",
		inMint, outMint, amount,
	)
	raw, status := jupGet(client, url)
	if raw == nil {
		tspSourceCall.WithLabelValues("jup_quote", status).Inc()
		return 0, false
	}
	var q quoteResp
	if err := json.Unmarshal(raw, &q); err != nil || q.OutAmount == "" {
		tspSourceCall.WithLabelValues("jup_quote", "parse").Inc()
		return 0, false
	}
	n, err := strconv.ParseFloat(q.OutAmount, 64)
	if err != nil || n <= 0 {
		tspSourceCall.WithLabelValues("jup_quote", "decode").Inc()
		return 0, false
	}
	tspSourceCall.WithLabelValues("jup_quote", "ok").Inc()
	return n, true
}

// fetchOnchainPrices returns the executable mid price in USDC per UI
// share for every symbol. Sequential with quoteGap spacing: ~26s for
// the 12-symbol cohort, comfortably inside the 60s tick.
func fetchOnchainPrices(client *http.Client, multipliers map[string]float64) map[string]float64 {
	prices := make(map[string]float64, len(assets))
	start := time.Now()
	for _, a := range assets {
		mult := 1.0
		if m, ok := multipliers[a.Mint]; ok && m > 0 {
			mult = m
		}

		// Sell leg: 1 raw share -> USDC.
		sellOut, okSell := quoteOut(client, a.Mint, usdcMint, oneShareRaw)
		time.Sleep(quoteGap)
		sellPx := 0.0
		if okSell {
			sellPx = sellOut / 1e6 * mult
		}

		// Buy leg: spend the sell proceeds, see how many shares return.
		buyPx := 0.0
		if okSell {
			gotRaw, okBuy := quoteOut(client, usdcMint, a.Mint, int64(sellOut))
			if okBuy && gotRaw > 0 {
				buyPx = (sellOut / 1e6) / (gotRaw / 1e8 / mult)
			}
			time.Sleep(quoteGap)
		}

		switch {
		case sellPx > 0 && buyPx > 0:
			prices[strings.ToLower(a.Symbol)] = (sellPx + buyPx) / 2
		case sellPx > 0:
			prices[strings.ToLower(a.Symbol)] = sellPx
		}
	}
	tspSourceLatency.WithLabelValues("onchain").Set(float64(time.Since(start).Milliseconds()))
	return prices
}
