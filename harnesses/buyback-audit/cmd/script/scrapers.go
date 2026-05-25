package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// httpClient is shared across scrapers — keep one to reuse connections.
var httpClient = &http.Client{Timeout: httpTimeout}

// ----- low-level helpers -----

func httpGetJSON(ctx context.Context, target string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ocb-buyback-audit/1.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("parse %s: %w (body=%s)", target, err, truncate(string(body), 200))
	}
	return nil
}

func httpPostJSON(ctx context.Context, target string, payload any, out any) error {
	buf, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ocb-buyback-audit/1.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("parse %s: %w (body=%s)", target, err, truncate(string(body), 200))
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// ----- CoinGecko (USD oracle) -----

func coingeckoUSD(ctx context.Context, ids ...string) (map[string]float64, error) {
	if len(ids) == 0 {
		return map[string]float64{}, nil
	}
	u := "https://api.coingecko.com/api/v3/simple/price?ids=" + strings.Join(ids, ",") + "&vs_currencies=usd"
	var raw map[string]map[string]float64
	if err := httpGetJSON(ctx, u, &raw); err != nil {
		return nil, err
	}
	out := make(map[string]float64, len(raw))
	for k, v := range raw {
		out[k] = v["usd"]
	}
	return out, nil
}

// ----- DeFiLlama (revenue baseline → promised_usd) -----

type llamaSummary struct {
	TotalDataChart [][2]float64 `json:"totalDataChart"`
}

// defillamaRevenueWindow returns the sum of dailyRevenue (USD) over the
// trailing window. We use dailyRevenue because every protocol in scope
// quotes its buyback share against revenue (not gross fees).
//
// Bucket alignment: DefiLlama returns daily buckets stamped at 00:00 UTC.
// A naive `p[0] >= now-window` filter excludes the bucket straddling the
// cutoff timestamp, causing a systematic ~14% underestimate (6 of 7
// buckets captured instead of 7). Instead we sort and take the last N
// closed buckets where N = window in days.
func defillamaRevenueWindow(ctx context.Context, slug string, window time.Duration) (float64, error) {
	u := "https://api.llama.fi/summary/fees/" + url.PathEscape(slug) + "?dataType=dailyRevenue"
	var s llamaSummary
	if err := httpGetJSON(ctx, u, &s); err != nil {
		return 0, err
	}
	days := int(window.Hours() / 24)
	if days <= 0 || len(s.TotalDataChart) == 0 {
		return 0, nil
	}
	sort.Slice(s.TotalDataChart, func(i, j int) bool {
		return s.TotalDataChart[i][0] < s.TotalDataChart[j][0]
	})
	start := len(s.TotalDataChart) - days
	if start < 0 {
		start = 0
	}
	sum := 0.0
	for _, p := range s.TotalDataChart[start:] {
		sum += p[1]
	}
	return sum, nil
}

// ----- Etherscan v2 (executed_usd for EVM treasuries) -----

type etherscanTx struct {
	TimeStamp string `json:"timeStamp"`
	From      string `json:"from"`
	To        string `json:"to"`
	Value     string `json:"value"`
	IsError   string `json:"isError"`
}

type etherscanResp struct {
	Status  string        `json:"status"`
	Message string        `json:"message"`
	Result  []etherscanTx `json:"result"`
}

// etherscanTokenInflows returns the sum of ERC20 transfers INTO `address`
// for the given `contractAddr` token within the trailing window. Used
// by buyback programs whose executor receives the bought-back token
// (e.g. Sky SBE receives SKY purchased on Uniswap). Returns amount in
// token units (caller multiplies by tokenDec scaling + USD price).
//
// Tolerates a missing API key by returning (0, nil), so the caller can
// emit a 0-value gauge rather than crash.
func etherscanTokenInflows(ctx context.Context, chainID int, recipient, contractAddr string, decimals int, window time.Duration) (float64, error) {
	key := etherscanAPIKey()
	if key == "" {
		return 0, nil
	}
	if decimals <= 0 {
		decimals = 18
	}
	cutoff := time.Now().Add(-window).Unix()
	addr := strings.ToLower(recipient)
	totalUnits := new(big.Float)
	page := 1
	const offset = 10000
	const maxPages = 5
	for page <= maxPages {
		q := url.Values{}
		q.Set("chainid", strconv.Itoa(chainID))
		q.Set("module", "account")
		q.Set("action", "tokentx")
		q.Set("address", recipient)
		q.Set("contractaddress", contractAddr)
		q.Set("startblock", "0")
		q.Set("endblock", "99999999")
		q.Set("page", strconv.Itoa(page))
		q.Set("offset", strconv.Itoa(offset))
		q.Set("sort", "desc")
		q.Set("apikey", key)
		full := etherscanV2Endpoint + "?" + q.Encode()
		var r etherscanResp
		if err := httpGetJSON(ctx, full, &r); err != nil {
			return 0, err
		}
		if r.Status == "0" && strings.Contains(strings.ToLower(r.Message), "no transactions") {
			break
		}
		if len(r.Result) == 0 {
			break
		}
		oldest := r.Result[len(r.Result)-1].TimeStamp
		for _, tx := range r.Result {
			ts, _ := strconv.ParseInt(tx.TimeStamp, 10, 64)
			if ts < cutoff {
				continue
			}
			if !strings.EqualFold(tx.To, addr) {
				continue // we only count inflows
			}
			v, ok := new(big.Float).SetString(tx.Value)
			if !ok {
				continue
			}
			totalUnits.Add(totalUnits, v)
		}
		if oldest != "" {
			ts, _ := strconv.ParseInt(oldest, 10, 64)
			if ts < cutoff {
				break
			}
		}
		if len(r.Result) < offset {
			break
		}
		page++
		time.Sleep(250 * time.Millisecond)
	}
	scale := new(big.Float).SetFloat64(1)
	for i := 0; i < decimals; i++ {
		scale.Mul(scale, big.NewFloat(10))
	}
	out, _ := new(big.Float).Quo(totalUnits, scale).Float64()
	return out, nil
}

// etherscanOutflows returns the sum of native-token outflows (in token
// units, e.g. ETH for chainid=1, ARB-native ETH for chainid=42161) from
// `address` within the trailing window. It walks paginated txlist (up
// to 5 pages of 10k each — plenty for a 30-day audit window).
//
// The function intentionally tolerates a missing API key: it returns
// (0, nil) so the caller can emit a 0-value gauge instead of crashing.
func etherscanOutflows(ctx context.Context, chainID int, address string, window time.Duration) (float64, error) {
	key := etherscanAPIKey()
	if key == "" {
		return 0, nil
	}
	cutoff := time.Now().Add(-window).Unix()
	addr := strings.ToLower(address)
	totalWei := new(big.Float)
	page := 1
	const offset = 10000
	const maxPages = 5
	for page <= maxPages {
		q := url.Values{}
		q.Set("chainid", strconv.Itoa(chainID))
		q.Set("module", "account")
		q.Set("action", "txlist")
		q.Set("address", address)
		q.Set("startblock", "0")
		q.Set("endblock", "99999999")
		q.Set("page", strconv.Itoa(page))
		q.Set("offset", strconv.Itoa(offset))
		q.Set("sort", "desc")
		q.Set("apikey", key)
		full := etherscanV2Endpoint + "?" + q.Encode()
		var r etherscanResp
		if err := httpGetJSON(ctx, full, &r); err != nil {
			return 0, err
		}
		// status=="0" is "No transactions found" (Message) — not fatal.
		if r.Status == "0" && strings.Contains(strings.ToLower(r.Message), "no transactions") {
			break
		}
		if len(r.Result) == 0 {
			break
		}
		oldest := r.Result[len(r.Result)-1].TimeStamp
		for _, tx := range r.Result {
			if tx.IsError == "1" {
				continue
			}
			ts, _ := strconv.ParseInt(tx.TimeStamp, 10, 64)
			if ts < cutoff {
				continue
			}
			if !strings.EqualFold(tx.From, addr) {
				continue // we only count outflows
			}
			v, ok := new(big.Float).SetString(tx.Value)
			if !ok {
				continue
			}
			totalWei.Add(totalWei, v)
		}
		// If the oldest tx on this page is already older than the cutoff,
		// further pages are guaranteed to be out of window (sort=desc).
		if oldest != "" {
			ts, _ := strconv.ParseInt(oldest, 10, 64)
			if ts < cutoff {
				break
			}
		}
		if len(r.Result) < offset {
			break
		}
		page++
		// Stay polite with the free key (5 req/s ceiling).
		time.Sleep(250 * time.Millisecond)
	}
	// Convert wei → ether (1e18) as float64.
	eth, _ := new(big.Float).Quo(totalWei, big.NewFloat(1e18)).Float64()
	return eth, nil
}

// ----- Hyperliquid info API (executed_usd for Assistance Fund) -----

type hlAssetCtx struct {
	OraclePx string `json:"oraclePx"`
}

type hlMetaAndAssetCtxs struct {
	// The endpoint returns [meta, []assetCtx]. We capture both halves.
	Universe []struct {
		Name string `json:"name"`
	}
	Ctxs []hlAssetCtx
}

// UnmarshalJSON walks the heterogeneous [meta, assetCtxs] array.
func (h *hlMetaAndAssetCtxs) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if len(raw) < 2 {
		return fmt.Errorf("metaAndAssetCtxs: expected 2 elements, got %d", len(raw))
	}
	var meta struct {
		Universe []struct {
			Name string `json:"name"`
		} `json:"universe"`
	}
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		return err
	}
	h.Universe = meta.Universe
	if err := json.Unmarshal(raw[1], &h.Ctxs); err != nil {
		return err
	}
	return nil
}

func hyperliquidHYPEOraclePrice(ctx context.Context) (float64, error) {
	var out hlMetaAndAssetCtxs
	if err := httpPostJSON(ctx, "https://api.hyperliquid.xyz/info",
		map[string]string{"type": "metaAndAssetCtxs"}, &out); err != nil {
		return 0, err
	}
	// Find HYPE in the universe and pull its oracle price.
	for i, u := range out.Universe {
		if strings.EqualFold(u.Name, "HYPE") && i < len(out.Ctxs) {
			f, err := strconv.ParseFloat(out.Ctxs[i].OraclePx, 64)
			if err != nil {
				return 0, err
			}
			return f, nil
		}
	}
	return 0, fmt.Errorf("HYPE not found in metaAndAssetCtxs universe")
}

type hlFill struct {
	Time    int64  `json:"time"` // ms
	Coin    string `json:"coin"`
	Side    string `json:"side"` // "B" = buy
	Px      string `json:"px"`
	Sz      string `json:"sz"`
	ClosedP string `json:"closedPnl"`
}

// HYPE-USDC spot pair on Hyperliquid is exposed by the info API as the
// synthetic coin `@107` (index 107 in spotMeta, base token = 150 = HYPE,
// quote = 0 = USDC). The perp coin is just `HYPE`. The Assistance Fund
// buys on spot so we match `@107` first, with `HYPE` as a fallback.
const hypeSpotCoin = "@107"

// hyperliquidBuybackUSD aggregates HYPE buy-fills made by the Assistance
// Fund over the window. `userFillsByTime` returns up to 2000 fills sorted
// ASCENDING by time within [startTime, endTime] — so a single call only
// surfaces the oldest 2000 fills in the window. For the high-frequency AF
// (often >2000 fills per day) we paginate FORWARD using newest+1 as the
// next startTime, until a page returns fewer than 2000 fills or crosses
// endMs.
func hyperliquidBuybackUSD(ctx context.Context, user string, window time.Duration) (float64, error) {
	startMs := time.Now().Add(-window).UnixMilli()
	endMs := time.Now().UnixMilli()
	var usd float64
	// Safety cap: 60 pages × 2000 fills = up to 120k fills per window,
	// well above any realistic AF cadence for a 30-day audit.
	const maxPages = 60
	cursor := startMs
	for page := 0; page < maxPages; page++ {
		var fills []hlFill
		body := map[string]any{
			"type":      "userFillsByTime",
			"user":      user,
			"startTime": cursor,
			"endTime":   endMs,
		}
		if err := httpPostJSON(ctx, "https://api.hyperliquid.xyz/info", body, &fills); err != nil {
			return 0, err
		}
		if len(fills) == 0 {
			break
		}
		var newest int64
		for _, f := range fills {
			if f.Time > newest {
				newest = f.Time
			}
			if f.Time < startMs || f.Time > endMs {
				continue
			}
			// Accept the HYPE spot pair (`@107`) and the perp coin (`HYPE`).
			if f.Coin != hypeSpotCoin && !strings.EqualFold(f.Coin, "HYPE") {
				continue
			}
			if !strings.EqualFold(f.Side, "B") {
				continue // only count buys (= buybacks)
			}
			px, _ := strconv.ParseFloat(f.Px, 64)
			sz, _ := strconv.ParseFloat(f.Sz, 64)
			usd += px * sz
		}
		// Fewer than 2000 means we've consumed the whole remaining range.
		if len(fills) < 2000 {
			break
		}
		// Advance cursor forward to newest+1 (strict, avoid the dupe).
		if newest >= endMs {
			break
		}
		cursor = newest + 1
		// Polite to HL API between paginated calls.
		time.Sleep(200 * time.Millisecond)
	}
	return usd, nil
}
