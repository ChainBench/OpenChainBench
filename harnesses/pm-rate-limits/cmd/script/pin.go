package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Pin selection rules (shared intent across venues): the most liquid market
// that is near-the-money (a 0.999 book is degenerate, its latency profile is
// not representative) and expires more than 24h out (Limitless lists 5-minute
// markets whose expiry turns every later probe into a CDN-cached 400).
const minPinHorizon = 24 * time.Hour

func fetchJSON(ctx context.Context, c *http.Client, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

func pinPolymarket(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	var markets []struct {
		Slug          string `json:"slug"`
		ConditionId   string `json:"conditionId"`
		EndDate       string `json:"endDate"`
		ClobTokenIds  string `json:"clobTokenIds"`
		OutcomePrices string `json:"outcomePrices"`
	}
	url := "https://gamma-api.polymarket.com/markets?limit=50&order=volume24hr&ascending=false&closed=false"
	if err := fetchJSON(ctx, c, url, &markets); err != nil {
		return Pin{}, err
	}
	for _, m := range markets {
		if m.Slug == avoid {
			continue
		}
		end, err := time.Parse(time.RFC3339, m.EndDate)
		if err != nil || time.Until(end) < minPinHorizon {
			continue
		}
		var prices []string
		if json.Unmarshal([]byte(m.OutcomePrices), &prices) != nil || len(prices) == 0 {
			continue
		}
		p0, err := strconv.ParseFloat(prices[0], 64)
		if err != nil || p0 < 0.15 || p0 > 0.85 {
			continue
		}
		var tokens []string
		if json.Unmarshal([]byte(m.ClobTokenIds), &tokens) != nil || len(tokens) == 0 {
			continue
		}
		return Pin{Market: m.Slug, Token: tokens[0], Condition: m.ConditionId, Expiry: end}, nil
	}
	return Pin{}, errors.New("polymarket: no near-the-money market with >24h horizon in top 50")
}

func pinKalshi(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	// Kalshi serves stats as fixed-point strings (volume_24h_fp,
	// yes_bid_dollars); the legacy numeric fields are always null.
	// min_close_ts pushes the >24h horizon filter server-side.
	var out struct {
		Markets []struct {
			Ticker    string `json:"ticker"`
			Volume24h string `json:"volume_24h_fp"`
			YesBid    string `json:"yes_bid_dollars"`
			CloseTime string `json:"close_time"`
		} `json:"markets"`
	}
	minClose := time.Now().Add(minPinHorizon).Unix()
	url := fmt.Sprintf("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open&min_close_ts=%d", minClose)
	if err := fetchJSON(ctx, c, url, &out); err != nil {
		return Pin{}, err
	}
	best := Pin{}
	bestVol := -1.0
	for _, m := range out.Markets {
		if m.Ticker == avoid {
			continue
		}
		vol, err := strconv.ParseFloat(m.Volume24h, 64)
		if err != nil || vol <= 0 {
			continue
		}
		bid, err := strconv.ParseFloat(m.YesBid, 64)
		if err != nil || bid < 0.15 || bid > 0.85 {
			continue
		}
		close, err := time.Parse(time.RFC3339, m.CloseTime)
		if err != nil || time.Until(close) < minPinHorizon {
			continue
		}
		if vol > bestVol {
			bestVol = vol
			best = Pin{Market: m.Ticker, Expiry: close}
		}
	}
	if best.Market == "" {
		return Pin{}, errors.New("kalshi: no liquid near-the-money market with >24h horizon")
	}
	return best, nil
}

func pinLimitless(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	// limit caps at 25 (400 above) and the first pages are 5-minute/hourly
	// markets, so paginate the whole active board to reach the long-dated
	// liquid ones (World Cup style markets live deep in the list).
	best := Pin{}
	bestVol := -1.0
	for page := 1; page <= 50; page++ {
		var out struct {
			Data []struct {
				Slug                string `json:"slug"`
				ExpirationTimestamp int64  `json:"expirationTimestamp"`
				VolumeFormatted     string `json:"volumeFormatted"`
				TradeType           string `json:"tradeType"`
				MarketType          string `json:"marketType"`
			} `json:"data"`
		}
		url := fmt.Sprintf("https://api.limitless.exchange/markets/active?limit=25&page=%d", page)
		if err := fetchJSON(ctx, c, url, &out); err != nil {
			if best.Market != "" {
				break // partial scan is fine, keep the best so far
			}
			return Pin{}, err
		}
		for _, m := range out.Data {
			if m.Slug == avoid || m.Slug == "" {
				continue
			}
			// Only single CLOB markets have an orderbook endpoint. The list's
			// tradeType is not always consistent with the market detail, so a
			// mislabel still lands on probe_invalid and re-pins.
			if m.TradeType != "clob" || m.MarketType != "single" {
				continue
			}
			exp := time.UnixMilli(m.ExpirationTimestamp)
			if time.Until(exp) < minPinHorizon {
				continue
			}
			vol, _ := strconv.ParseFloat(m.VolumeFormatted, 64)
			if vol > bestVol {
				bestVol = vol
				best = Pin{Market: m.Slug, Expiry: exp}
			}
		}
		if len(out.Data) < 25 {
			break
		}
		select {
		case <-ctx.Done():
			return Pin{}, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	if best.Market == "" {
		return Pin{}, errors.New("limitless: no active market with >24h horizon (board is mostly 5min/hourly)")
	}
	return best, nil
}

func pinManifold(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	var markets []struct {
		ID          string  `json:"id"`
		Probability float64 `json:"probability"`
		CloseTime   int64   `json:"closeTime"`
	}
	url := "https://api.manifold.markets/v0/search-markets?term=&sort=liquidity&filter=open&contractType=BINARY&limit=20"
	if err := fetchJSON(ctx, c, url, &markets); err != nil {
		return Pin{}, err
	}
	for _, m := range markets {
		if m.ID == avoid {
			continue
		}
		close := time.UnixMilli(m.CloseTime)
		if time.Until(close) < minPinHorizon {
			continue
		}
		if m.Probability < 0.2 || m.Probability > 0.8 {
			continue
		}
		return Pin{Market: m.ID, Expiry: close}, nil
	}
	return Pin{}, errors.New("manifold: no near-the-money binary market with >24h horizon")
}

func pinMyriad(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	var out struct {
		Data []struct {
			Slug      string  `json:"slug"`
			ExpiresAt string  `json:"expiresAt"`
			Volume    float64 `json:"volume"`
		} `json:"data"`
	}
	url := "https://api-v2.myriadprotocol.com/markets?state=open&limit=20"
	if err := fetchJSON(ctx, c, url, &out); err != nil {
		return Pin{}, err
	}
	best := Pin{}
	bestVol := -1.0
	for _, m := range out.Data {
		if m.Slug == avoid || m.Slug == "" {
			continue
		}
		exp, err := time.Parse(time.RFC3339, m.ExpiresAt)
		if err != nil || time.Until(exp) < minPinHorizon {
			continue
		}
		if m.Volume > bestVol {
			bestVol = m.Volume
			best = Pin{Market: m.Slug, Expiry: exp}
		}
	}
	if best.Market == "" {
		return Pin{}, errors.New("myriad: no open market with >24h horizon")
	}
	return best, nil
}

// stalenessPolymarket reads the ms timestamp Polymarket embeds in every book
// response (string in the docs, tolerate a bare number).
func stalenessPolymarket(class string, body []byte) (int64, bool) {
	if class != "book" {
		return 0, false
	}
	var b struct {
		Timestamp any `json:"timestamp"`
	}
	if json.Unmarshal(body, &b) != nil {
		return 0, false
	}
	switch t := b.Timestamp.(type) {
	case string:
		ms, err := strconv.ParseInt(t, 10, 64)
		return ms, err == nil
	case float64:
		return int64(t), true
	}
	return 0, false
}

// stalenessManifold reads lastUpdatedTime (ms) from the single-market payload.
func stalenessManifold(class string, body []byte) (int64, bool) {
	if class != "price" {
		return 0, false
	}
	var m struct {
		LastUpdatedTime int64 `json:"lastUpdatedTime"`
	}
	if json.Unmarshal(body, &m) != nil || m.LastUpdatedTime == 0 {
		return 0, false
	}
	return m.LastUpdatedTime, true
}
