package main

import (
	"bytes"
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

func pinPredictIt(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	var out struct {
		Markets []struct {
			ID        int    `json:"id"`
			Name      string `json:"name"`
			Status    string `json:"status"`
			Contracts []struct {
				ID             int     `json:"id"`
				LastTradePrice float64 `json:"lastTradePrice"`
				BestBuyYesCost float64 `json:"bestBuyYesCost"`
				Volume         float64 `json:"volume"` // may be null -> 0
			} `json:"contracts"`
		} `json:"markets"`
	}
	if err := fetchJSON(ctx, c, "https://www.predictit.org/api/marketdata/all", &out); err != nil {
		return Pin{}, fmt.Errorf("predictit list: %w", err)
	}
	best := Pin{}
	bestVol := -1.0
	for _, m := range out.Markets {
		if m.Status != "Open" || len(m.Contracts) != 2 {
			continue
		}
		id := fmt.Sprintf("%d", m.ID)
		if id == avoid {
			continue
		}
		// Use the first contract's lastTradePrice as a proxy for YES probability
		p := m.Contracts[0].LastTradePrice
		if p < 0.15 || p > 0.85 {
			continue
		}
		vol := 0.0
		for _, ct := range m.Contracts {
			vol += ct.Volume
		}
		if vol > bestVol {
			bestVol = vol
			best = Pin{Market: id, Expiry: time.Now().Add(72 * time.Hour)} // optimistic horizon
		}
	}
	if best.Market == "" {
		return Pin{}, errors.New("predictit: no open binary market with near-the-money price")
	}
	return best, nil
}

func pinSmarkets(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	// Step 1: get popular upcoming politics events
	var eventsOut struct {
		Events []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"events"`
	}
	evURL := "https://api.smarkets.com/v3/events/?type_domain=politics&sort=popular&per_page=20&state=upcoming"
	if err := fetchJSON(ctx, c, evURL, &eventsOut); err != nil {
		return Pin{}, fmt.Errorf("smarkets events: %w", err)
	}
	// Step 2: for each event, look for binary markets with real quotes
	for _, ev := range eventsOut.Events {
		var mktsOut struct {
			Markets []struct {
				ID          string `json:"id"`
				Name        string `json:"name"`
				Type        string `json:"type"`
				DisplayType string `json:"display_type"`
				State       string `json:"state"`
			} `json:"markets"`
		}
		mkURL := fmt.Sprintf("https://api.smarkets.com/v3/events/%s/markets/?per_page=20", ev.ID)
		if err := fetchJSON(ctx, c, mkURL, &mktsOut); err != nil {
			continue
		}
		for _, m := range mktsOut.Markets {
			if m.State != "open" {
				continue
			}
			if m.ID == avoid {
				continue
			}
			// Verify the quotes endpoint returns data before committing
			var quotes struct {
				Contracts map[string]interface{} `json:"contracts"`
			}
			qURL := fmt.Sprintf("https://api.smarkets.com/v3/markets/%s/quotes/", m.ID)
			if err := fetchJSON(ctx, c, qURL, &quotes); err != nil || len(quotes.Contracts) == 0 {
				continue
			}
			return Pin{
				Market: m.ID,
				Expiry: time.Now().Add(72 * time.Hour),
			}, nil
		}
	}
	return Pin{}, errors.New("smarkets: no open politics market with live quotes found")
}

func pinMetaculus(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	var out struct {
		Results []struct {
			ID        int    `json:"id"`
			CloseTime string `json:"close_time"`
			Active    bool   `json:"active"`
		} `json:"results"`
	}
	url := "https://www.metaculus.com/api2/questions/?limit=50&order_by=-activity&status=open&type=forecast&forecast_type=binary"
	if err := fetchJSON(ctx, c, url, &out); err != nil {
		return Pin{}, fmt.Errorf("metaculus list: %w", err)
	}
	for _, m := range out.Results {
		if !m.Active {
			continue
		}
		id := fmt.Sprintf("%d", m.ID)
		if id == avoid {
			continue
		}
		ct, err := time.Parse(time.RFC3339, m.CloseTime)
		if err != nil {
			continue
		}
		if time.Until(ct) < minPinHorizon {
			continue
		}
		return Pin{Market: id, Expiry: ct}, nil
	}
	return Pin{}, errors.New("metaculus: no open binary question with >24h close horizon")
}

func pinBetfair(ctx context.Context, c *http.Client, avoid string) (Pin, error) {
	const catalogueURL = "https://api.betfair.com/exchange/betting/rest/v1.0/listMarketCatalogue/"
	body := []byte(`{"filter":{"inPlayOnly":false},"sort":"FIRST_TO_START","maxResults":"200","marketProjection":["MARKET_START_TIME","RUNNER_DESCRIPTION"]}`)

	var markets []struct {
		MarketID        string            `json:"marketId"`
		MarketStartTime string            `json:"marketStartTime"`
		Runners         []json.RawMessage `json:"runners"`
	}
	if err := postJSON(ctx, c, catalogueURL, body, &markets, betfairRequestMutator()); err != nil {
		return Pin{}, fmt.Errorf("betfair catalogue: %w", err)
	}
	for _, m := range markets {
		if m.MarketID == avoid || len(m.Runners) != 2 {
			continue
		}
		// Betfair uses "2006-01-02T15:04:05.000Z" format
		start, err := time.Parse("2006-01-02T15:04:05.000Z", m.MarketStartTime)
		if err != nil {
			start, err = time.Parse(time.RFC3339, m.MarketStartTime)
			if err != nil {
				continue
			}
		}
		if time.Until(start) < 48*time.Hour {
			continue
		}
		return Pin{Market: m.MarketID, Expiry: start}, nil
	}
	return Pin{}, errors.New("betfair: no binary market with >48h horizon in first 200 results")
}

// postJSON sends a POST request with a JSON body and decodes the JSON response.
func postJSON(ctx context.Context, c *http.Client, url string, body []byte, out any, mutator func(*http.Request)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if mutator != nil {
		mutator(req)
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
		return fmt.Errorf("status %d: %s", resp.StatusCode, b)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
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
