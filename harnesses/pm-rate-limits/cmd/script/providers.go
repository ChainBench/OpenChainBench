package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Per-source probe URL builders + auth header injection for the
// aggregator routes added alongside the direct venue probes. Each
// function returns the URL the warm probe should hit for a given pinned
// market on the given venue, plus any provider specific request mutator
// that adds the auth header.
//
// Predexon enforces a 1 rps global cap across the org. A package-level
// token bucket gates every Predexon HTTP call regardless of which venue
// or region triggered it.

var (
	predexonBucketMu sync.Mutex
	predexonLastCall time.Time
	predexonMinDelay = 1100 * time.Millisecond // 1 rps + 100ms safety
)

func throttlePredexon() {
	predexonBucketMu.Lock()
	defer predexonBucketMu.Unlock()
	now := time.Now()
	if elapsed := now.Sub(predexonLastCall); elapsed < predexonMinDelay {
		time.Sleep(predexonMinDelay - elapsed)
	}
	predexonLastCall = time.Now()
}

// Mobula price endpoint. Polymarket only. Token id required, returned
// from gamma in clobTokenIds[0] (YES outcome).
func mobulaPolymarketURL(_ string, pin Pin) string {
	return fmt.Sprintf("https://api.mobula.io/api/2/pm/market/price?platform=polymarket&outcomeId=%s", pin.Token)
}

func mobulaAuth(key string) func(*http.Request) {
	return func(req *http.Request) {
		if key != "" {
			req.Header.Set("Authorization", key)
		}
	}
}

// Predexon URL builders per venue.
func predexonPolymarketURL(_ string, pin Pin) string {
	return fmt.Sprintf("https://api.predexon.com/v2/polymarket/market-price/%s?at_time=%d", pin.Token, time.Now().Unix())
}

func predexonKalshiURL(_ string, pin Pin) string {
	return fmt.Sprintf("https://api.predexon.com/v2/kalshi/markets?ticker=%s", pin.Market)
}

func predexonLimitlessURL(_ string, pin Pin) string {
	return fmt.Sprintf("https://api.predexon.com/v2/limitless/markets?slug=%s", pin.Market)
}

func predexonAuth(key string) func(*http.Request) {
	return func(req *http.Request) {
		if key != "" {
			req.Header.Set("x-api-key", key)
		}
	}
}

// Codex GraphQL. JWT minted from DEFINED_SESSION_COOKIE in codex_auth.go,
// cached 23h. We POST the predictionMarketPrice query for the pinned
// marketId — conditionId for Polymarket, ticker for Kalshi. On mint
// failure we skip the Authorization header and let the upstream answer
// 401 so the probe is bucketed as an auth error (the right signal,
// rather than swallowing the call).
const codexGraphQLURL = "https://graph.codex.io/graphql"

func codexBody(marketId string) []byte {
	if marketId == "" {
		return nil
	}
	return []byte(fmt.Sprintf(
		`{"query":"{predictionMarketPrice(input:{marketId:\"%s\"}){marketId timestamp outcomes{outcomeId}}}"}`,
		marketId,
	))
}

func codexAuth(cookie string) func(*http.Request) {
	return func(req *http.Request) {
		jwt, err := GetCodexJWT(cookie)
		if err != nil {
			log.Printf("[codex] jwt mint failed (request will go unauthenticated): %v", err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+jwt)
	}
}

// codexErrorLogOnce logs the first Codex error response per (venue, region)
// at most once per minute. Surface the GraphQL error body so we can tell
// NOT_AUTHORIZED (tier gate, kill the loop) from marketId/schema issues
// (fix the bodyfunc and keep the loop).
var (
	codexErrorLogMu   sync.Mutex
	codexErrorLogLast = map[string]time.Time{}
)

func codexErrorLogOnce(venue, region string, body []byte) {
	codexErrorLogMu.Lock()
	defer codexErrorLogMu.Unlock()
	key := venue + "|" + region
	last := codexErrorLogLast[key]
	if time.Since(last) < time.Minute {
		return
	}
	codexErrorLogLast[key] = time.Now()
	snippet := string(body)
	if len(snippet) > 400 {
		snippet = snippet[:400] + "..."
	}
	log.Printf("[codex-debug] %s/%s error body: %s", venue, region, snippet)
}

// Codex stores PM markets under a composite marketId of the form
// "<marketAddress>:<Venue>:<exchange>:<network>" for chain venues and
// "<slug>:<Venue>" for off chain.
//
// For Polymarket the marketAddress is the contract address of one
// specific market outcome, not the gamma conditionId and not the CLOB
// token id. The only documented way to obtain it is to call
// filterPredictionMarkets, which returns the canonical composite id
// directly. We cache the top-volume Polymarket market id at startup and
// refresh hourly, then every Codex/Polymarket probe targets that one
// market. The bench measures Codex latency against its own canonical
// market; the apples-to-apples is "same harness, same JWT, same
// endpoint, every 5 s, three regions".
var (
	codexPolymarketIDMu sync.RWMutex
	codexPolymarketID   string
)

func setCodexPolymarketID(id string) {
	codexPolymarketIDMu.Lock()
	defer codexPolymarketIDMu.Unlock()
	codexPolymarketID = id
}

func getCodexPolymarketID() string {
	codexPolymarketIDMu.RLock()
	defer codexPolymarketIDMu.RUnlock()
	return codexPolymarketID
}

// codexPolymarketMarketID returns the cached canonical Codex composite
// id (set by codexDiscoveryProbe). Until the first discovery succeeds
// it returns the empty string and codexBody short-circuits to nil so
// the probe surfaces a clean http_4xx rather than an undefined query.
// The pin argument is unused now: Codex does not resolve from gamma
// conditionId or CLOB token id, so we cannot map our pinned market onto
// Codex's identifier space without an external lookup.
func codexPolymarketMarketID(_ string) string {
	return getCodexPolymarketID()
}

func codexKalshiMarketID(ticker string) string {
	if ticker == "" {
		return ""
	}
	return ticker + ":Kalshi"
}

// codexDiscoveryProbe queries filterPredictionMarkets at startup and
// every hour to capture the top-volume Polymarket market id Codex
// indexes. The returned `results[0].id` is the composite key we feed
// into predictionMarketPrice. We do not try to resolve our gamma pin
// onto a Codex id because the documented surfaces do not support that
// lookup; instead Codex/Polymarket probes always target the current
// top-volume Polymarket market in Codex's index, which is stable enough
// across a few hours to give honest latency numbers.
func codexDiscoveryProbe(cookie string, client *http.Client) {
	// Wait so the first JWT mint has a chance to succeed: the probe
	// loops will race the discovery for the cache otherwise.
	time.Sleep(15 * time.Second)
	for {
		if id, ok := runCodexDiscoveryOnce(cookie, client); ok {
			setCodexPolymarketID(id)
			log.Printf("[codex-discovery] polymarket canonical id set: %s", id)
		}
		time.Sleep(1 * time.Hour)
	}
}

func runCodexDiscoveryOnce(cookie string, client *http.Client) (string, bool) {
	const query = `{"query":"{filterPredictionMarkets(filters:{protocol:[POLYMARKET],status:[OPEN]},rankings:[{attribute:volumeUsd24h,direction:DESC}],limit:3){results{id market{label}}}}"}`
	for attempt := 1; attempt <= 5; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "POST", codexGraphQLURL, bytes.NewReader([]byte(query)))
		req.Header.Set("Content-Type", "application/json")
		jwt, err := GetCodexJWT(cookie)
		if err != nil {
			cancel()
			log.Printf("[codex-discovery] attempt %d: jwt mint failed: %v", attempt, err)
			time.Sleep(30 * time.Second)
			continue
		}
		req.Header.Set("Authorization", "Bearer "+jwt)
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			log.Printf("[codex-discovery] attempt %d: request failed: %v", attempt, err)
			time.Sleep(30 * time.Second)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		snippet := string(body)
		if len(snippet) > 800 {
			snippet = snippet[:800] + "..."
		}
		log.Printf("[codex-discovery] response status=%d body: %s", resp.StatusCode, snippet)
		// Cheap parse: pull the first "id":"...:Polymarket:..." occurrence.
		const idMarker = `"id":"`
		i := strings.Index(string(body), idMarker)
		if i < 0 {
			return "", false
		}
		j := strings.Index(string(body)[i+len(idMarker):], `"`)
		if j < 0 {
			return "", false
		}
		id := string(body)[i+len(idMarker) : i+len(idMarker)+j]
		return id, true
	}
	log.Printf("[codex-discovery] gave up after 5 attempts")
	return "", false
}
