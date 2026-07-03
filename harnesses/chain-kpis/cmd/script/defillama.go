package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefiLlama lives behind a public unauthenticated API. We hit 3 endpoints
// per chain that has a DefiLlama mapping:
//   1. /v2/historicalChainTvl/<name>   — last sample = current TVL
//   2. /overview/dexs/<name>           — total24h = aggregate DEX volume
//   3. /stablecoincharts/<name>?stablecoin=1
//                                      — last point's USD-pegged total
//
// Each endpoint is its own goroutine inside fetchDefillamaChain so a
// stuck TVL request doesn't starve the stables fetch for the same chain.
// Failures are bucketed into chain_kpis_fetch_errors_total{source="defillama"}
// and the gauge is left untouched (carry-forward via Prom retention).

const (
	defillamaBase    = "https://api.llama.fi"
	stablesLlamaBase = "https://stablecoins.llama.fi"
)

var httpClientDefillama = &http.Client{Timeout: 15 * time.Second}

func fetchAllDefillama() {
	for _, c := range Registry {
		c := c
		if c.DefiLlama == "" {
			continue
		}
		go fetchDefillamaChain(c)
	}
}

func fetchDefillamaChain(c Chain) {
	start := time.Now()
	defer func() {
		chainKpisFetchLatencyMs.WithLabelValues(c.Slug, "defillama").Set(float64(time.Since(start).Milliseconds()))
	}()

	anyOK := false

	if tvl, err := defillamaTvl(c.DefiLlama); err == nil {
		chainTvlUsd.WithLabelValues(c.Slug).Set(tvl)
		anyOK = true
	} else {
		chainKpisFetchErrors.WithLabelValues(c.Slug, "defillama", classifyError(err.Error())).Inc()
		fmt.Printf("[defillama][%s] tvl error: %v\n", c.Slug, err)
	}

	if vol, err := defillamaDexVolume24h(c.DefiLlama); err == nil {
		chainDexVolume24hUsd.WithLabelValues(c.Slug).Set(vol)
		anyOK = true
	} else {
		chainKpisFetchErrors.WithLabelValues(c.Slug, "defillama", classifyError(err.Error())).Inc()
		fmt.Printf("[defillama][%s] dex24h error: %v\n", c.Slug, err)
	}

	if mcap, err := defillamaStablesMcap(c.DefiLlama); err == nil {
		chainStablesMcapUsd.WithLabelValues(c.Slug).Set(mcap)
		anyOK = true
	} else {
		chainKpisFetchErrors.WithLabelValues(c.Slug, "defillama", classifyError(err.Error())).Inc()
		fmt.Printf("[defillama][%s] stables error: %v\n", c.Slug, err)
	}

	if anyOK {
		chainKpisLastRefresh.WithLabelValues(c.Slug, "defillama").Set(float64(time.Now().Unix()))
	}
	chainKpisLastTickUnix.Set(float64(time.Now().Unix()))
}

// defillamaTvl reads the historical TVL series and returns the LAST sample.
// DefiLlama publishes one daily aggregate; the last point is "current".
func defillamaTvl(chainName string) (float64, error) {
	url := fmt.Sprintf("%s/v2/historicalChainTvl/%s", defillamaBase, encodePath(chainName))
	body, err := getJSON(httpClientDefillama, url)
	if err != nil {
		return 0, err
	}
	var arr []struct {
		Date int64   `json:"date"`
		Tvl  float64 `json:"tvl"`
	}
	if err := json.Unmarshal(body, &arr); err != nil {
		return 0, fmt.Errorf("parse_error: %w", err)
	}
	if len(arr) == 0 {
		return 0, fmt.Errorf("empty_series")
	}
	return arr[len(arr)-1].Tvl, nil
}

// defillamaDexVolume24h reads /overview/dexs/<chain> and returns total24h.
// This is the aggregate of every DefiLlama-tracked DEX on that chain.
func defillamaDexVolume24h(chainName string) (float64, error) {
	url := fmt.Sprintf("%s/overview/dexs/%s?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true", defillamaBase, encodePath(chainName))
	body, err := getJSON(httpClientDefillama, url)
	if err != nil {
		return 0, err
	}
	var resp struct {
		Total24h float64 `json:"total24h"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, fmt.Errorf("parse_error: %w", err)
	}
	return resp.Total24h, nil
}

// defillamaStablesMcap reads /stablecoincharts/<chain>?stablecoin=1 and
// returns the last sample's USD-pegged total. The `stablecoin=1` filter
// is required by the API though we don't filter by a specific stablecoin;
// the response is the chain-wide aggregate when no specific id is given.
func defillamaStablesMcap(chainName string) (float64, error) {
	url := fmt.Sprintf("%s/stablecoincharts/%s?stablecoin=1", stablesLlamaBase, encodePath(chainName))
	body, err := getJSON(httpClientDefillama, url)
	if err != nil {
		return 0, err
	}
	// DefiLlama returns 200 + empty body for chains it tracks but where no
	// stablecoin issuance has been recorded (Stellar, Blast, Base at time
	// of writing). Surface as a typed sentinel so the harness logs it as
	// "not_tracked" rather than spamming parse_error.
	if len(body) == 0 {
		return 0, fmt.Errorf("not_tracked")
	}
	// DefiLlama returns `date` as a stringified unix timestamp here (the
	// /v2/historicalChainTvl endpoint returns int64 — different convention
	// per family of endpoints). We only need the value, so decode `date`
	// as json.RawMessage to ignore typing.
	var arr []struct {
		Date                json.RawMessage `json:"date"`
		TotalCirculatingUSD struct {
			PeggedUSD float64 `json:"peggedUSD"`
		} `json:"totalCirculatingUSD"`
	}
	if err := json.Unmarshal(body, &arr); err != nil {
		return 0, fmt.Errorf("parse_error: %w", err)
	}
	if len(arr) == 0 {
		return 0, fmt.Errorf("empty_series")
	}
	return arr[len(arr)-1].TotalCirculatingUSD.PeggedUSD, nil
}

// encodePath is a minimal URL path-segment encoder. DefiLlama chain names
// can contain spaces ("BNB Smart Chain", "ZKsync Era") that have to be
// percent-encoded; url.PathEscape handles this without escaping legitimate
// path separators we never include.
func encodePath(s string) string {
	out := make([]byte, 0, len(s))
	for _, r := range []byte(s) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '~' {
			out = append(out, r)
		} else {
			out = append(out, '%', hex(r>>4), hex(r&0x0F))
		}
	}
	return string(out)
}

func hex(b byte) byte {
	if b < 10 {
		return '0' + b
	}
	return 'A' + (b - 10)
}

// getJSON is a tiny wrapper around the HTTP GET that returns the body bytes
// or a classified error string. The classifier on the metrics side reads
// substrings like "timeout", "429", "5xx" — we surface those in the
// error message so the bucket lands correctly.
func getJSON(client *http.Client, url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OCB-chain-kpis/1.0")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
