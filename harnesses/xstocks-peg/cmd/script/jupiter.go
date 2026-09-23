package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
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

// fetchMultipliers returns the Token-2022 ScaledUiAmount multiplier per
// mint, read on-chain from the mint account's scaledUiAmountConfig
// extension in one getMultipleAccounts call (jsonParsed): newMultiplier
// once its effective timestamp has passed, multiplier before. Jupiter's
// price/v3 used to carry usdPricePrescaled at the top level; the field
// moved under scaledUiConfig and the harness silently read a multiplier
// of 1.0 for every mint, which put the seven scaled xStocks 17 to 59 bps
// above their reference (audit 2026-09-23). The chain is the source now,
// Jupiter's scaledUiConfig the fallback. Mints without the extension
// map to 1.0; a scaled mint the tick could not read is absent from the
// map, and the caller publishes nothing for it.
func fetchMultipliers(client *http.Client) map[string]float64 {
	out := map[string]float64{}
	ids := make([]string, 0, len(assets))
	for _, a := range assets {
		ids = append(ids, a.Mint)
	}
	if m := fetchMultipliersOnchain(client, ids); m != nil {
		for k, v := range m {
			out[k] = v
		}
	}
	if len(out) == len(ids) {
		return out
	}
	// Fallback: Jupiter's scaledUiConfig for the mints the chain read missed.
	raw, status := jupGet(client, "https://lite-api.jup.ag/price/v3?ids="+strings.Join(ids, ","))
	if raw == nil {
		tspSourceCall.WithLabelValues("jup_price", status).Inc()
		return out
	}
	var flat map[string]struct {
		ScaledUiConfig *struct {
			Multiplier                      float64 `json:"multiplier"`
			NewMultiplier                   float64 `json:"newMultiplier"`
			NewMultiplierEffectiveTimestamp int64   `json:"newMultiplierEffectiveTimestamp"`
		} `json:"scaledUiConfig"`
	}
	if err := json.Unmarshal(raw, &flat); err != nil {
		tspSourceCall.WithLabelValues("jup_price", "parse").Inc()
		return out
	}
	now := time.Now().Unix()
	for mint, v := range flat {
		if _, ok := out[mint]; ok {
			continue
		}
		if v.ScaledUiConfig == nil {
			continue
		}
		out[mint] = effectiveMultiplier(v.ScaledUiConfig.Multiplier, v.ScaledUiConfig.NewMultiplier, v.ScaledUiConfig.NewMultiplierEffectiveTimestamp, now)
	}
	tspSourceCall.WithLabelValues("jup_price", "ok").Inc()
	return out
}

func effectiveMultiplier(current, next float64, effectiveAt, now int64) float64 {
	if next > 0 && effectiveAt > 0 && now >= effectiveAt {
		return next
	}
	if current > 0 {
		return current
	}
	return 1
}

// fetchMultipliersOnchain reads every mint account in one call. A mint
// without the scaledUiAmountConfig extension is 1.0; a mint the RPC did
// not return is left out.
func fetchMultipliersOnchain(client *http.Client, mints []string) map[string]float64 {
	quoted := make([]string, len(mints))
	for i, m := range mints {
		quoted[i] = `"` + m + `"`
	}
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[[` + strings.Join(quoted, ",") + `],{"encoding":"jsonParsed"}]}`)
	req, _ := http.NewRequest("POST", solanaRPC(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		tspSourceCall.WithLabelValues("solana_rpc", "network").Inc()
		return nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != 200 {
		tspSourceCall.WithLabelValues("solana_rpc", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return nil
	}
	var envel struct {
		Result struct {
			Value []*struct {
				Data struct {
					Parsed struct {
						Info struct {
							Extensions []struct {
								Extension string `json:"extension"`
								State     struct {
									Multiplier                      string `json:"multiplier"`
									NewMultiplier                   string `json:"newMultiplier"`
									NewMultiplierEffectiveTimestamp int64  `json:"newMultiplierEffectiveTimestamp"`
								} `json:"state"`
							} `json:"extensions"`
						} `json:"info"`
					} `json:"parsed"`
				} `json:"data"`
			} `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || len(envel.Result.Value) != len(mints) {
		tspSourceCall.WithLabelValues("solana_rpc", "parse").Inc()
		return nil
	}
	now := time.Now().Unix()
	out := map[string]float64{}
	for i, acct := range envel.Result.Value {
		if acct == nil {
			continue
		}
		m := 1.0
		for _, e := range acct.Data.Parsed.Info.Extensions {
			if e.Extension != "scaledUiAmountConfig" {
				continue
			}
			cur, _ := strconv.ParseFloat(e.State.Multiplier, 64)
			next, _ := strconv.ParseFloat(e.State.NewMultiplier, 64)
			m = effectiveMultiplier(cur, next, e.State.NewMultiplierEffectiveTimestamp, now)
		}
		out[mints[i]] = m
	}
	tspSourceCall.WithLabelValues("solana_rpc", "ok").Inc()
	return out
}

// solanaRPC is the Solana endpoint for the mint reads (XS_SOLANA_RPC,
// a keyed endpoint on the VPS; the public default is rate limited but
// one call a minute passes).
func solanaRPC() string {
	if v := strings.TrimSpace(os.Getenv("XS_SOLANA_RPC")); v != "" {
		return v
	}
	return "https://solana-rpc.publicnode.com"
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
var sweepCount int

func fetchOnchainPrices(client *http.Client, multipliers map[string]float64) map[string]float64 {
	prices := make(map[string]float64, len(assets))
	start := time.Now()
	// Rotate the starting symbol each sweep: a 27 s sweep quotes the last
	// symbol 25 s after the first against one reference read, and a fixed
	// order gave the tail of the list a permanent few bps of market motion
	// (audit 2026-09-23). Rotation spreads it across the cohort.
	sweepCount++
	offset := sweepCount % len(assets)
	for k := range assets {
		a := assets[(k+offset)%len(assets)]
		scaled, ok := multipliers[a.Mint]
		if !ok || scaled <= 0 {
			// Unknown multiplier this tick: a scaled mint priced at 1.0
			// reads up to 59 bps high, so no price is better than that one.
			tspSourceCall.WithLabelValues("multiplier", "missing").Inc()
			continue
		}
		tspScaledMultiplier.WithLabelValues(strings.ToLower(a.Symbol)).Set(scaled)
		// 1e8 raw units are `scaled` shares (the UI amount), so a price per
		// raw unit becomes a price per share by dividing by the multiplier;
		// the formulas below keep Jupiter's old convention where mult was
		// usdPrice / usdPricePrescaled, i.e. 1 / multiplier.
		mult := 1 / scaled

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
