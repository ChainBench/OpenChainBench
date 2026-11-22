package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Hyperliquid: 100% public no-auth. Three calls per sample:
//   POST /info {"type":"l2Book","coin":"ETH"}        → orderbook
//   POST /info {"type":"metaAndAssetCtxs"}           → funding rate
//   POST /info {"type":"userFees","user":"0x000.."}  → taker fee schedule

const hyperliquidURL = "https://api.hyperliquid.xyz/info"

type hlL2Book struct {
	Coin   string `json:"coin"`
	Levels [][]struct {
		Px string `json:"px"`
		Sz string `json:"sz"`
	} `json:"levels"`
}

type hlAssetCtx struct {
	Funding      string `json:"funding"` // per-hour, signed
	OpenInterest string `json:"openInterest"`
	MidPx        string `json:"midPx"`
	MarkPx       string `json:"markPx"`
}

type hlUserFees struct {
	FeeSchedule struct {
		Cross string `json:"cross"` // taker base, e.g. "0.00045" = 4.5 bps
		Add   string `json:"add"`   // maker base
	} `json:"feeSchedule"`
}

var (
	errEmptyOrderbook = errors.New("empty_orderbook")
	errBadMid         = errors.New("bad_mid")
)

func hlMidAndAsks(book hlL2Book) (float64, []bookLevel, error) {
	if len(book.Levels) < 2 || len(book.Levels[0]) == 0 || len(book.Levels[1]) == 0 {
		return 0, nil, errEmptyOrderbook
	}
	bestBid, _ := strconv.ParseFloat(book.Levels[0][0].Px, 64)
	bestAsk, _ := strconv.ParseFloat(book.Levels[1][0].Px, 64)
	mid := (bestBid + bestAsk) / 2
	if mid <= 0 {
		return 0, nil, errBadMid
	}
	asks := make([]bookLevel, 0, len(book.Levels[1]))
	for _, a := range book.Levels[1] {
		px, _ := strconv.ParseFloat(a.Px, 64)
		sz, _ := strconv.ParseFloat(a.Sz, 64)
		asks = append(asks, bookLevel{Px: px, Sz: sz})
	}
	return mid, asks, nil
}

func fetchHyperliquid(v VenueConfig, endpoint string) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	// 1) Orderbook
	var book hlL2Book
	if err := hlPost(client, endpoint, map[string]any{"type": "l2Book", "coin": v.Asset}, &book); err != nil {
		s.Err = fmt.Sprintf("l2book: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	mid, levels, err := hlMidAndAsks(book)
	if err != nil {
		s.Err = err.Error()
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.MidPrice = mid

	effective, err := walkBookForNotional(levels, v.NotionalUSD)
	if err != nil {
		s.Err = fmt.Sprintf("walk: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.SpreadBps = (effective - mid) / mid * 10000

	// 2) Funding rate via metaAndAssetCtxs
	var metaResp []json.RawMessage
	metaReq := map[string]any{"type": "metaAndAssetCtxs"}
	if err := hlPost(client, endpoint, metaReq, &metaResp); err == nil && len(metaResp) >= 2 {
		var ctxs []hlAssetCtx
		if err := json.Unmarshal(metaResp[1], &ctxs); err == nil {
			// Find ETH ctx by index — meta[0].universe[i].name == v.Asset
			var meta struct {
				Universe []struct {
					Name string `json:"name"`
				} `json:"universe"`
			}
			if err := json.Unmarshal(metaResp[0], &meta); err == nil {
				for i, u := range meta.Universe {
					if u.Name == v.Asset && i < len(ctxs) {
						f, _ := strconv.ParseFloat(ctxs[i].Funding, 64)
						s.FundingRatePerHrBps = f * 10000
						break
					}
				}
			}
		}
	}

	// 3) Taker fee via userFees probe. Hard requirement: if this fails the
	// all-in number would silently miss the fee component, so we error out
	// and skip publishing this cycle instead.
	var fees hlUserFees
	if err := hlPost(client, endpoint, map[string]any{
		"type": "userFees",
		"user": "0x0000000000000000000000000000000000000000",
	}, &fees); err != nil {
		s.Err = fmt.Sprintf("userFees: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if fees.FeeSchedule.Cross == "" {
		s.Err = "userFees_empty"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	cross, _ := strconv.ParseFloat(fees.FeeSchedule.Cross, 64)
	s.TakerFeeBps = cross * 10000
	if add, err := strconv.ParseFloat(fees.FeeSchedule.Add, 64); err == nil {
		s.MakerFeeBps, s.HasMakerFee = add*10000, true
	}

	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	// Notional tiers: rewalk the already-fetched book at $1k/$10k/$100k.
	// The raw l2Book returns the top 20 price levels per side. On deep
	// books (ETH ~$7M visible) that covers the $1M tier; on thinner ones
	// (SOL ~$450k) it cannot. Refetch with nSigFigs=5, the finest price
	// aggregation HL offers: same 20 levels but each bucket groups nearby
	// prices, extending USD coverage with negligible price rounding.
	tierMid, tierLevels := mid, levels
	if _, err := walkBookForNotional(levels, tierNotionals[len(tierNotionals)-1]); err != nil {
		var deep hlL2Book
		deepReq := map[string]any{"type": "l2Book", "coin": v.Asset, "nSigFigs": 5}
		if err := hlPost(client, endpoint, deepReq, &deep); err == nil {
			if deepMid, deepAsks, err := hlMidAndAsks(deep); err == nil {
				tierMid, tierLevels = deepMid, deepAsks
			}
		}
	}
	applyBookTiers(&s, tierLevels, tierMid)
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func hlPost(client *http.Client, endpoint string, body any, out any) error {
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", endpoint, bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	return json.Unmarshal(respBody, out)
}
