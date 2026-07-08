package main

import (
	"bytes"
	"encoding/json"
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
	Funding      string `json:"funding"`     // per-hour, signed
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

func fetchHyperliquid(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	// 1) Orderbook
	var book hlL2Book
	if err := hlPost(client, map[string]any{"type": "l2Book", "coin": v.Asset}, &book); err != nil {
		s.Err = fmt.Sprintf("l2book: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Levels) < 2 || len(book.Levels[0]) == 0 || len(book.Levels[1]) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bids := book.Levels[0]
	asks := book.Levels[1]
	bestBid, _ := strconv.ParseFloat(bids[0].Px, 64)
	bestAsk, _ := strconv.ParseFloat(asks[0].Px, 64)
	mid := (bestBid + bestAsk) / 2
	if mid <= 0 {
		s.Err = "bad_mid"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.MidPrice = mid

	// Walk asks for v.NotionalUSD of buy
	effective, err := walkAsksForNotional(asks, v.NotionalUSD)
	if err != nil {
		s.Err = fmt.Sprintf("walk: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.SpreadBps = (effective - mid) / mid * 10000

	// 2) Funding rate via metaAndAssetCtxs
	var metaResp []json.RawMessage
	if err := hlPost(client, map[string]any{"type": "metaAndAssetCtxs"}, &metaResp); err == nil && len(metaResp) >= 2 {
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
	if err := hlPost(client, map[string]any{
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

	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func hlPost(client *http.Client, body any, out any) error {
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", hyperliquidURL, bytes.NewBuffer(bodyBytes))
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

// walkAsksForNotional walks the ask side until $notional has been matched
// and returns the size-weighted effective price.
func walkAsksForNotional(asks []struct {
	Px string `json:"px"`
	Sz string `json:"sz"`
}, notional float64) (float64, error) {
	matched := 0.0
	totalQty := 0.0
	for _, a := range asks {
		px, _ := strconv.ParseFloat(a.Px, 64)
		sz, _ := strconv.ParseFloat(a.Sz, 64)
		if px <= 0 || sz <= 0 {
			continue
		}
		levelCost := px * sz
		if matched+levelCost >= notional {
			partial := (notional - matched) / px
			totalQty += partial
			matched = notional
			break
		}
		matched += levelCost
		totalQty += sz
	}
	if matched < notional*0.99 || totalQty == 0 {
		return 0, fmt.Errorf("insufficient_depth: matched=%.2f of %.2f", matched, notional)
	}
	return notional / totalQty, nil
}
