package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// One per-venue parser. Each returns a single mid-price for the
// configured pair; the rest of the pipeline is venue-agnostic.

const httpTimeout = 6 * time.Second

// poll dispatches to the right parser for the source's venue. We
// deliberately don't use a generic interface — each venue's JSON
// quirks are different enough that an explicit per-venue parser is
// the simpler design.
func poll(ctx context.Context, s Source) (float64, error) {
	switch s.Venue {
	case "binance":
		return pollBinance(ctx, s.URL)
	case "kraken":
		return pollKraken(ctx, s.URL, s.Pair)
	case "bitstamp":
		return pollBitstamp(ctx, s.URL)
	case "curve_3pool":
		// USDC (i=1) -> DAI (i=0) with input 1_000_000 (= $1).
		// Returns price of DAI per USDC. Decimal: input 6 dec, output 18 dec.
		return pollCurveGetDy(ctx, s.URL, curve3poolAddr, 1, 0, "0xf4240", 1e18)
	case "curve_3pool_rev":
		// DAI (i=0) -> USDC (i=1) with input 1e18 (= $1).
		// Returns price of USDC per DAI. Decimal: input 18 dec, output 6 dec.
		return pollCurveGetDy(ctx, s.URL, curve3poolAddr, 0, 1, "0xde0b6b3a7640000", 1e6)
	default:
		return 0, fmt.Errorf("unknown venue: %s", s.Venue)
	}
}

// ─── Binance ───────────────────────────────────────────────────────

type binTicker struct {
	Symbol   string `json:"symbol"`
	BidPrice string `json:"bidPrice"`
	AskPrice string `json:"askPrice"`
}

func pollBinance(ctx context.Context, url string) (float64, error) {
	body, status, err := httpGet(ctx, url)
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("http %d", status)
	}
	var t binTicker
	if err := json.Unmarshal(body, &t); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	bid, e1 := strconv.ParseFloat(t.BidPrice, 64)
	ask, e2 := strconv.ParseFloat(t.AskPrice, 64)
	if e1 != nil || e2 != nil || bid <= 0 || ask <= 0 {
		return 0, fmt.Errorf("invalid bid/ask: %q/%q", t.BidPrice, t.AskPrice)
	}
	return (bid + ask) / 2, nil
}

// ─── Kraken ────────────────────────────────────────────────────────

type krakResp struct {
	Error  []string                  `json:"error"`
	Result map[string]krakTickerData `json:"result"`
}

type krakTickerData struct {
	Ask []string `json:"a"`
	Bid []string `json:"b"`
	C   []string `json:"c"`
}

func pollKraken(ctx context.Context, url, requestedPair string) (float64, error) {
	body, status, err := httpGet(ctx, url)
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("http %d", status)
	}
	var r krakResp
	if err := json.Unmarshal(body, &r); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if len(r.Error) > 0 {
		return 0, fmt.Errorf("kraken err: %v", r.Error)
	}
	// Kraken returns the result keyed by its internal name which
	// may differ from the requested pair (USDTUSD → USDTZUSD).
	// We only have one entry per request so just take the first.
	for _, t := range r.Result {
		if len(t.Bid) == 0 || len(t.Ask) == 0 {
			return 0, fmt.Errorf("empty bid/ask")
		}
		bid, e1 := strconv.ParseFloat(t.Bid[0], 64)
		ask, e2 := strconv.ParseFloat(t.Ask[0], 64)
		if e1 != nil || e2 != nil || bid <= 0 || ask <= 0 {
			return 0, fmt.Errorf("invalid bid/ask: %q/%q", t.Bid[0], t.Ask[0])
		}
		return (bid + ask) / 2, nil
	}
	return 0, fmt.Errorf("no result rows")
}

// ─── Bitstamp ──────────────────────────────────────────────────────

type bitstampTicker struct {
	Bid  string `json:"bid"`
	Ask  string `json:"ask"`
	Last string `json:"last"`
}

func pollBitstamp(ctx context.Context, url string) (float64, error) {
	body, status, err := httpGet(ctx, url)
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("http %d", status)
	}
	var t bitstampTicker
	if err := json.Unmarshal(body, &t); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	bid, e1 := strconv.ParseFloat(t.Bid, 64)
	ask, e2 := strconv.ParseFloat(t.Ask, 64)
	if e1 != nil || e2 != nil || bid <= 0 || ask <= 0 {
		return 0, fmt.Errorf("invalid bid/ask: %q/%q", t.Bid, t.Ask)
	}
	return (bid + ask) / 2, nil
}

// ─── Curve onchain via eth_call get_dy(i, j, _dx) ──────────────────

const curve3poolAddr = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7"

// pollCurveGetDy issues `get_dy(int128 i, int128 j, uint256 _dx)` on
// the pool. We construct the calldata manually rather than depend on
// a full ABI encoder — the function selector is the keccak prefix
// `0x5e0d443f`, then three 32-byte values padded left.
//
// outDecimalScale: the divisor to apply to the raw hex result to get
// a price denominated as "output tokens per 1 unit of input". For
// 3pool USDC(6)->DAI(18), the result is in 1e18, so divide by 1e18.
func pollCurveGetDy(ctx context.Context, rpcURL, pool string, i, j int, dxHex string, outDecimalScale float64) (float64, error) {
	calldata := "0x5e0d443f" +
		padLeft64(fmt.Sprintf("%x", i)) +
		padLeft64(fmt.Sprintf("%x", j)) +
		padLeft64(strings.TrimPrefix(dxHex, "0x"))
	body := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"%s","data":"%s"},"latest"],"id":1}`, pool, calldata))
	req, _ := http.NewRequestWithContext(ctx, "POST", rpcURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	raw, status, err := httpDo(req)
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("http %d", status)
	}
	var r struct {
		Result string `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return 0, fmt.Errorf("rpc: %s", r.Error.Message)
	}
	if r.Result == "" || r.Result == "0x" {
		return 0, fmt.Errorf("empty result")
	}
	hex := strings.TrimPrefix(r.Result, "0x")
	// Parse as big int via float to avoid overflow on 18-dec
	// outputs. uint256 can exceed int64, but for stables ≈ 1 the
	// actual numeric value sits comfortably in float64.
	rawN, err := strconv.ParseUint(hex, 16, 64)
	if err != nil {
		// Try the slow path for very large values.
		return parseLargeHex(hex, outDecimalScale)
	}
	return float64(rawN) / outDecimalScale, nil
}

// parseLargeHex handles the case where the get_dy output exceeds
// uint64 (18-decimal outputs near 1.0 = ~1e18 which overflows).
func parseLargeHex(hex string, scale float64) (float64, error) {
	// Strip leading zeros so the strconv path can re-try.
	hex = strings.TrimLeft(hex, "0")
	if hex == "" {
		return 0, nil
	}
	// Take the upper 16 hex digits (64 bits) to keep precision,
	// then scale down. For stables ≈ 1.0 we never need full
	// precision beyond 12 significant digits.
	if len(hex) <= 16 {
		n, err := strconv.ParseUint(hex, 16, 64)
		if err != nil {
			return 0, err
		}
		return float64(n) / scale, nil
	}
	// Fall back: take top 16 digits, exponent-adjust scale.
	top := hex[:16]
	exp := len(hex) - 16
	n, err := strconv.ParseUint(top, 16, 64)
	if err != nil {
		return 0, err
	}
	out := float64(n)
	for i := 0; i < exp; i++ {
		out *= 16
	}
	return out / scale, nil
}

func padLeft64(s string) string {
	for len(s) < 64 {
		s = "0" + s
	}
	return s
}

// ─── HTTP helpers ──────────────────────────────────────────────────

func httpGet(ctx context.Context, url string) ([]byte, int, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	return httpDo(req)
}

func httpDo(req *http.Request) ([]byte, int, error) {
	client := &http.Client{Timeout: httpTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}
