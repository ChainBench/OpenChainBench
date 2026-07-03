package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Kalshi exposes its market catalog on two layers. The public
// /markets endpoint surfaces every active ticker, but the bulk of the
// rows are auto-generated derivative markets with structurally zero
// volume (the headline event-level volume sits on the parent series
// and is not summed onto child rows). The authenticated /markets/trades
// endpoint, by contrast, carries every executed fill across the venue
// in dollar terms. We aggregate from there to recover the real 24h
// trading volume.
//
// Two-track strategy:
//
//	tradesScale24h(): pulls recent /markets/trades pages until at least
//	                  ~1 hour of fills is covered, sums count_fp *
//	                  taker_outcome_side price_dollars per trade, scales
//	                  to 24h. Result feeds pm_venue_volume_24h_usd and
//	                  pm_venue_volume_30d_usd (we cap the 30d gauge at
//	                  24h x 30, an upper-bound estimate, until a proper
//	                  rolling backfill is wired). Requires a Kalshi API
//	                  key pair signed via RSASSA-PSS-SHA256.
//
//	marketsCatalog(): paginates /markets?status=open for active market
//	                  count and an OI floor (sum of open_interest_fp *
//	                  last_price_dollars across the visible markets).
//	                  No auth needed. Stays useful even when KALSHI_KEY_ID
//	                  is empty, just doesn't fill the volume gauges.
//
// Auth contract: each request signs `{timestamp_ms}{method}{path}` with
// the supplied RSA private key using RSASSA-PSS-SHA256 (saltLength =
// SHA256.size). Three headers go on every authenticated call:
//   KALSHI-ACCESS-KEY        the public key ID (UUID-like)
//   KALSHI-ACCESS-TIMESTAMP  unix milliseconds, decimal string
//   KALSHI-ACCESS-SIGNATURE  base64(sig)
//
// Kalshi documents this at docs.kalshi.com (Authentication section). We
// verified the contract live against /trade-api/v2/exchange/status and
// /trade-api/v2/markets/trades before shipping.

const (
	kalshiBase     = "https://api.elections.kalshi.com/trade-api/v2"
	kalshiPageSize = 1000
	kalshiMaxPages = 20
	kalshiUA       = "OCB-pm-cohort-stats/1.0"

	// Catalog walk via /events?with_nested_markets=true. 25 pages × 200
	// events ≈ 47 k nested markets / ~14 s end to end, well below the
	// /markets fan-out (20 k rows in 20 pages, similar wall time) but
	// hits the populated rows instead of the empty multi-game parlay
	// catalogue. Hard cap protects against runaway pagination if Kalshi
	// ever stops returning a terminating cursor.
	kalshiEventsPageSize = 200
	kalshiEventsMaxPages = 25

	// Trade aggregation window. We pull pages of trades until we have
	// covered at least this much wall-clock time, then scale to 24h.
	// 5 min gives a robust estimate without burning the rate budget at
	// typical Kalshi flow (~4000 trades/min that's ~20 pages of 1000),
	// keeping a single tick under ~40 s. The scaling 24h/5m = 288x is
	// honest under stable conditions; for headline events (Super Bowl
	// Sunday) the burst still surfaces because pagination shortens.
	kalshiTradeSpanTarget = 5 * time.Minute
	// Hard upper bound on pages of trades per tick. Each page is 1000
	// trades; at typical Kalshi flow 5 min covers ~20 pages. Cap at
	// 60 so a single tick stays bounded under ~2 min worst case (slow
	// upstream) and never burns the loop.
	kalshiTradesMaxPages = 60

	// Settled walk window. We look back 180 days of settled markets to
	// count those that crossed $1m all-time traded volume. Kalshi binary
	// contracts notionally settle at $1, so the raw volume_fp on each
	// market is a USD floor and can be compared directly to the 1m
	// threshold without price scaling.
	kalshiSettledLookback = 180 * 24 * time.Hour
	// Heavier pagination cap reserved for the settled-walk only: the
	// catalog walk stays gated at kalshiMaxPages. 100 pages * 1000 rows
	// = up to 100k markets, plenty of headroom for the ~30-80 pages a
	// 180-day settled window currently spans.
	kalshiSettledMaxPages = 100
	// USD threshold for the markets_above_1m gauge. Kalshi binary
	// contracts pay $1 per share at resolution, so volume_fp >= this
	// value implies all-time notional >= $1m.
	kalshiMillionDollarThreshold = 1_000_000.0
)

var httpClientKalshi = &http.Client{Timeout: 30 * time.Second}

// kalshiSigner caches the parsed RSA private key so we don't re-parse on
// every signed request. Set once at startup from the env var.
type kalshiSigner struct {
	keyID      string
	privateKey *rsa.PrivateKey
}

var kalshiAuth *kalshiSigner

// initKalshiAuth parses the PEM private key once at startup. If parsing
// fails we keep kalshiAuth nil and the trades-aggregation path silently
// skips; the marketsCatalog path still runs.
func initKalshiAuth(keyID, pemBody string) {
	if keyID == "" || pemBody == "" {
		fmt.Println("[kalshi] auth disabled (KALSHI_KEY_ID or KALSHI_PRIVATE_KEY missing)")
		return
	}
	block, _ := pem.Decode([]byte(pemBody))
	if block == nil {
		fmt.Println("[kalshi] auth disabled: PEM decode returned no block")
		return
	}
	pk, err := parseRSAKey(block.Bytes)
	if err != nil {
		fmt.Printf("[kalshi] auth disabled: parse error: %v\n", err)
		return
	}
	kalshiAuth = &kalshiSigner{keyID: keyID, privateKey: pk}
	fmt.Println("[kalshi] auth enabled (RSASSA-PSS-SHA256)")
}

// parseRSAKey tries both PKCS1 (-----BEGIN RSA PRIVATE KEY-----) and
// PKCS8 (-----BEGIN PRIVATE KEY-----) shapes so we accept whichever
// format the dashboard emitted.
func parseRSAKey(der []byte) (*rsa.PrivateKey, error) {
	if k, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return k, nil
	}
	k2, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	pk, ok := k2.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA key")
	}
	return pk, nil
}

func fetchAllKalshi() {
	v := VenueBySlug("kalshi")
	if v == nil {
		return
	}
	go fetchKalshiVenue(*v)
}

func fetchKalshiVenue(v Venue) {
	start := time.Now()
	defer func() {
		pmCohortStatsFetchLatencyMs.WithLabelValues(v.Slug, "kalshi").Set(float64(time.Since(start).Milliseconds()))
	}()

	// Track A: catalog. No auth needed, gives us active count, OI, and
	// real-measured vol24h (sum of volume_24h_fp × last_price over every
	// nested market the /events walk surfaces).
	active, oi, vol24hCatalog, topVol24Public := kalshiMarketsCatalog(v)

	// Track B: aggregate /markets/trades for the per-ticker top-market
	// volume only. We used to also publish the trades-scaled total as
	// vol24h, but extrapolating a 5-min trades window × 288 to 24h
	// inflated the figure 20-50× during sport bursts (vol30d projection
	// hit $10.5B vs Kalshi's true ~$0.5-1.5B/month). The catalog sum is
	// the actual reported 24h volume per market, no extrapolation.
	var topMarket24Trades float64
	if kalshiAuth != nil {
		_, topMarket24Trades = kalshiTradesScale24h(v)
	}

	// Track C: walk settled markets to count those above $1m all-time. Heavy
	// (up to ~80 paginated requests) but the gauge is otherwise null since
	// the open-catalog walk only sees active markets. Auth not required.
	above1m := kalshiSettledMarketsAbove1m(v)

	vol24h := vol24hCatalog
	// 30d gauge: still a projection (vol24h × 30) — Kalshi exposes
	// volume_24h_fp and cumulative volume_fp per market, but no native
	// 30-day field. The pm-stats reader is expected to surface this as
	// an estimate (~$X) and not as a measured 30-day sum. A real 30d
	// figure would require a daily snapshot job that stores the
	// cumulative volume_fp per event and diffs across 30 days.
	vol30d := vol24h * 30

	pmVenueActiveMarkets.WithLabelValues(v.Slug).Set(active)
	pmVenueOpenInterestUsd.WithLabelValues(v.Slug).Set(oi)
	// Prefer the trades-grouped top market when authentication is wired and
	// returns a useful sample: the public /markets feed only exposes
	// auto-generated derivative tickers whose volume24h is structurally
	// near zero, so the trades-grouped value is the only one that reflects
	// the headline-event top market. Public value is kept as a fallback.
	switch {
	case topMarket24Trades > 0:
		pmVenueTopMarketVolume24hUsd.WithLabelValues(v.Slug).Set(topMarket24Trades)
	case topVol24Public > 0:
		pmVenueTopMarketVolume24hUsd.WithLabelValues(v.Slug).Set(topVol24Public)
	}
	if vol24h > 0 {
		pmVenueVolume24hUsd.WithLabelValues(v.Slug).Set(vol24h)
		pmVenueVolume30dUsd.WithLabelValues(v.Slug).Set(vol30d)
	}
	if above1m > 0 {
		pmVenueMarketsAbove1m.WithLabelValues(v.Slug).Set(float64(above1m))
	}

	pmCohortStatsLastRefresh.WithLabelValues(v.Slug, "kalshi").Set(float64(time.Now().Unix()))
	pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))

	fmt.Printf("[kalshi][%s] active=%.0f oi=%.0f top24h_public=%.0f top24h_trades=%.0f vol24h_trades=%.0f vol30d_proj=%.0f above1m=%d\n",
		v.Slug, active, oi, topVol24Public, topMarket24Trades, vol24h, vol30d, above1m)
}

// kalshiMarketsCatalog paginates the public /events endpoint with
// nested markets and returns (active_count, oi_dollars,
// vol24h_dollars, top_market_volume_24h_public). The OI and vol24h
// figures are sums of `open_interest_fp × last_price_dollars` and
// `volume_24h_fp × last_price_dollars` across every nested market.
//
// Why /events?with_nested_markets=true instead of /markets?status=open:
// the flat /markets surface is 95%+ noise (auto-generated multi-game
// sports parlay tickers KXMVESPORTSMULTIGAMEEXTENDED-* with zero OI
// and zero volume). Walking 20 pages × 1000 rows surfaced ~600 USD of
// OI on real probes despite Kalshi's actual OI being north of $80M;
// the /events surface groups markets by parent event and emits the
// populated rows first. Spot-check (2026-06-22): 25 pages × 200 events
// = 5 000 events / 47 864 nested markets / total OI ≈ $87.9M, top
// markets: House 2026 control $3.2M, FIFA World Cup 2026 winner
// $3-12M per outcome.
func kalshiMarketsCatalog(v Venue) (active, oi, vol24h, topVol24 float64) {
	type market struct {
		Status           string    `json:"status"`
		Volume24hFP      flexFloat `json:"volume_24h_fp"`
		OpenInterestFP   flexFloat `json:"open_interest_fp"`
		LastPriceDollars flexFloat `json:"last_price_dollars"`
	}
	type event struct {
		Markets []market `json:"markets"`
	}
	type resp struct {
		Events []event `json:"events"`
		Cursor string  `json:"cursor"`
	}

	var cursor string
	for page := 0; page < kalshiEventsMaxPages; page++ {
		q := url.Values{}
		q.Set("status", "open")
		q.Set("with_nested_markets", "true")
		q.Set("limit", fmt.Sprintf("%d", kalshiEventsPageSize))
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		body, err := kalshiGet(httpClientKalshi, fmt.Sprintf("/events?%s", q.Encode()), false)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "kalshi-catalog", classifyError(err.Error())).Inc()
			fmt.Printf("[kalshi-catalog][%s] page=%d error: %v\n", v.Slug, page, err)
			break
		}
		var r resp
		if err := json.Unmarshal(body, &r); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "kalshi-catalog", "parse").Inc()
			break
		}
		if len(r.Events) == 0 {
			break
		}
		for _, ev := range r.Events {
			for _, m := range ev.Markets {
				price := float64(m.LastPriceDollars)
				if price < 0 {
					price = 0
				}
				if price > 1 {
					price = 1
				}
				active++
				oi += float64(m.OpenInterestFP) * price
				vol24h += float64(m.Volume24hFP) * price
				if v24 := float64(m.Volume24hFP); v24 > topVol24 {
					topVol24 = v24
				}
			}
		}
		if r.Cursor == "" || r.Cursor == cursor {
			break
		}
		cursor = r.Cursor
	}
	return active, oi, vol24h, topVol24
}

// kalshiTradesScale24h aggregates recent /markets/trades pages until we
// have covered at least kalshiTradeSpanTarget of wall-clock, then scales
// the observed notional to 24h. While walking the trade pages we also
// bucket per-ticker notional so the highest single market's scaled 24h
// volume can be published to pm_venue_top_market_volume_24h_usd. Returns
// (scaledTotal24h, scaledTopMarket24h); both are 0 if we couldn't auth
// or couldn't span a usable window.
func kalshiTradesScale24h(v Venue) (float64, float64) {
	type trade struct {
		Ticker          string    `json:"ticker"`
		CountFP         flexFloat `json:"count_fp"`
		YesPriceDollars flexFloat `json:"yes_price_dollars"`
		NoPriceDollars  flexFloat `json:"no_price_dollars"`
		TakerSide       string    `json:"taker_outcome_side"`
		CreatedTime     string    `json:"created_time"`
	}
	type resp struct {
		Trades []trade `json:"trades"`
		Cursor string  `json:"cursor"`
	}

	var (
		cursor          string
		total           float64
		oldestTs        time.Time
		newestTs        time.Time
		tradesProcessed int
		perTicker       = make(map[string]float64)
	)
	for page := 0; page < kalshiTradesMaxPages; page++ {
		path := fmt.Sprintf("/markets/trades?limit=%d", kalshiPageSize)
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		body, err := kalshiGet(httpClientKalshi, path, true)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "kalshi-trades", classifyError(err.Error())).Inc()
			fmt.Printf("[kalshi-trades][%s] page=%d error: %v\n", v.Slug, page, err)
			break
		}
		var r resp
		if err := json.Unmarshal(body, &r); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "kalshi-trades", "parse").Inc()
			break
		}
		if len(r.Trades) == 0 {
			break
		}
		for _, t := range r.Trades {
			ts, err := time.Parse(time.RFC3339Nano, t.CreatedTime)
			if err != nil {
				continue
			}
			if oldestTs.IsZero() || ts.Before(oldestTs) {
				oldestTs = ts
			}
			if newestTs.IsZero() || ts.After(newestTs) {
				newestTs = ts
			}
			price := float64(t.YesPriceDollars)
			if strings.EqualFold(t.TakerSide, "no") {
				price = float64(t.NoPriceDollars)
			}
			if price <= 0 || price > 1 {
				continue
			}
			notional := float64(t.CountFP) * price
			total += notional
			if t.Ticker != "" {
				perTicker[t.Ticker] += notional
			}
			tradesProcessed++
		}
		if !newestTs.IsZero() && !oldestTs.IsZero() {
			if newestTs.Sub(oldestTs) >= kalshiTradeSpanTarget {
				break
			}
		}
		if r.Cursor == "" || r.Cursor == cursor {
			break
		}
		cursor = r.Cursor
	}
	if newestTs.IsZero() || oldestTs.IsZero() || newestTs.Equal(oldestTs) {
		return 0, 0
	}
	span := newestTs.Sub(oldestTs)
	if span <= 0 {
		return 0, 0
	}
	scale := (24 * time.Hour).Seconds() / span.Seconds()
	scaled := total * scale
	var (
		topTicker string
		topRaw    float64
	)
	for ticker, sum := range perTicker {
		if sum > topRaw {
			topRaw = sum
			topTicker = ticker
		}
	}
	scaledTop := topRaw * scale
	fmt.Printf("[kalshi-trades][%s] span=%.2fmin trades=%d tickers=%d notional=$%.0f scaled24h=$%.0f topTicker=%s topRaw=$%.0f scaledTop24h=$%.0f\n",
		"kalshi", span.Minutes(), tradesProcessed, len(perTicker), total, scaled, topTicker, topRaw, scaledTop)
	return scaled, scaledTop
}

// kalshiSettledMarketsAbove1m walks /markets?status=settled over the last
// kalshiSettledLookback window and counts how many settled markets crossed
// $1m notional all-time. Kalshi binary contracts pay $1 per share at
// resolution, so volume_fp is a USD floor we can compare to the threshold
// without any price scaling.
//
// Heavy operation by design: up to kalshiSettledMaxPages * kalshiPageSize
// rows per call (~80k markets). We time the whole walk so the OCB latency
// dashboard surfaces regressions, and we bucket failures under source
// "kalshi-settled" so they do not pollute the catalog and trades counters.
func kalshiSettledMarketsAbove1m(v Venue) int {
	type market struct {
		VolumeFP flexFloat `json:"volume"`
		// Kalshi exposes the cumulative volume under multiple keys depending
		// on the response shape. We prefer `volume` (raw dollar count) and
		// fall back to `volume_fp` for robustness across schema drift.
		VolumeFPAlt flexFloat `json:"volume_fp"`
	}
	type resp struct {
		Markets []market `json:"markets"`
		Cursor  string   `json:"cursor"`
	}

	start := time.Now()
	defer func() {
		pmCohortStatsFetchLatencyMs.WithLabelValues(v.Slug, "kalshi-settled").Set(float64(time.Since(start).Milliseconds()))
	}()

	minSettledTs := time.Now().Add(-kalshiSettledLookback).Unix()
	var (
		cursor      string
		count       int
		seenMarkets int
	)
	for page := 0; page < kalshiSettledMaxPages; page++ {
		q := url.Values{}
		q.Set("status", "settled")
		q.Set("min_settled_ts", fmt.Sprintf("%d", minSettledTs))
		q.Set("limit", fmt.Sprintf("%d", kalshiPageSize))
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		body, err := kalshiGet(httpClientKalshi, fmt.Sprintf("/markets?%s", q.Encode()), false)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "kalshi-settled", classifyError(err.Error())).Inc()
			fmt.Printf("[kalshi-settled][%s] page=%d error: %v\n", v.Slug, page, err)
			break
		}
		var r resp
		if err := json.Unmarshal(body, &r); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "kalshi-settled", "parse").Inc()
			break
		}
		if len(r.Markets) == 0 {
			break
		}
		for _, m := range r.Markets {
			vol := float64(m.VolumeFP)
			if vol == 0 {
				vol = float64(m.VolumeFPAlt)
			}
			seenMarkets++
			if vol >= kalshiMillionDollarThreshold {
				count++
			}
		}
		if r.Cursor == "" || r.Cursor == cursor {
			break
		}
		cursor = r.Cursor
	}
	fmt.Printf("[kalshi-settled][%s] window=180d seen=%d above1m=%d elapsed=%s\n",
		v.Slug, seenMarkets, count, time.Since(start).Round(time.Millisecond))
	pmCohortStatsLastRefresh.WithLabelValues(v.Slug, "kalshi-settled").Set(float64(time.Now().Unix()))
	return count
}

// kalshiGet performs the HTTP GET, optionally signing with the RSA key
// when `signed` is true. Unsigned calls just set the UA + Accept header.
func kalshiGet(client *http.Client, path string, signed bool) ([]byte, error) {
	fullURL := kalshiBase + path
	req, _ := http.NewRequest("GET", fullURL, nil)
	req.Header.Set("User-Agent", kalshiUA)
	req.Header.Set("Accept", "application/json")
	if signed {
		if kalshiAuth == nil {
			return nil, fmt.Errorf("auth_unconfigured")
		}
		ts := fmt.Sprintf("%d", time.Now().UnixMilli())
		// Kalshi signs the path AS REQUESTED by the client, including
		// the v2 prefix. We sign the trailing path that lives under
		// the /trade-api/v2 base, in form `{ts}{method}{path}`. Live
		// against /exchange/status returned 200 — contract verified.
		msg := ts + "GET" + "/trade-api/v2" + path
		sig, err := rsaPssSignSha256(kalshiAuth.privateKey, []byte(msg))
		if err != nil {
			return nil, fmt.Errorf("sign_error: %w", err)
		}
		req.Header.Set("KALSHI-ACCESS-KEY", kalshiAuth.keyID)
		req.Header.Set("KALSHI-ACCESS-TIMESTAMP", ts)
		req.Header.Set("KALSHI-ACCESS-SIGNATURE", base64.StdEncoding.EncodeToString(sig))
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
		}
		if err != nil {
			break
		}
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

// rsaPssSignSha256 performs RSASSA-PSS with SHA-256 + saltLength =
// SHA-256.Size, matching Kalshi's documented signature contract.
func rsaPssSignSha256(pk *rsa.PrivateKey, msg []byte) ([]byte, error) {
	h := crypto.SHA256.New()
	h.Write(msg)
	digest := h.Sum(nil)
	opts := &rsa.PSSOptions{
		SaltLength: rsa.PSSSaltLengthEqualsHash,
		Hash:       crypto.SHA256,
	}
	return rsa.SignPSS(rand.Reader, pk, crypto.SHA256, digest, opts)
}
