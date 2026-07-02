package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const mobulaWS = "wss://pm-api-prod-eu.mobula.io"

// Cloudflare on the Mobula PM gateway blocks the default Go-http-client/1.1
// User-Agent silently — the subscribe ack comes back but no data frame
// ever fires. Spoofing a normal browser UA on the WS upgrade unblocks it.
const mobulaUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func runMobula(ctx context.Context, cfg Config, basketCh <-chan []Market) {
	if cfg.MobulaApiKey == "" {
		appendLog("[mobula] MOBULA_API_KEY not set — skipping Mobula provider")
		return
	}

	backoff := 5 * time.Second
	for ctx.Err() == nil {
		err := mobulaConnect(ctx, cfg.MobulaApiKey, basketCh)
		if ctx.Err() != nil {
			return
		}
		appendLog("[mobula] disconnected: %v — backing off %v", err, backoff)
		fetchErrors.WithLabelValues("mobula", "polymarket", classify(err)).Inc()
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 60*time.Second {
			backoff *= 2
		}
	}
}

func mobulaConnect(ctx context.Context, apiKey string, basketCh <-chan []Market) error {
	opts := &websocket.DialOptions{
		HTTPHeader: http.Header{
			"User-Agent": []string{mobulaUA},
			"Origin":     []string{"https://mobula.io"},
		},
	}
	conn, _, err := websocket.Dial(ctx, mobulaWS, opts)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusInternalError, "")
	conn.SetReadLimit(8 * 1024 * 1024)

	var (
		subMu      sync.Mutex
		subscribed = map[string]bool{} // conditionId
	)
	subscribeMissing := func(ms []Market) {
		subMu.Lock()
		defer subMu.Unlock()
		for _, m := range ms {
			if subscribed[m.ConditionId] {
				continue
			}
			subscribed[m.ConditionId] = true
			for _, channel := range []string{"pm-market-trade", "pm-market-price"} {
				sub := map[string]interface{}{
					"event": channel,
					"data": map[string]interface{}{
						"platform":      "polymarket",
						"marketId":      m.ConditionId,
						"authorization": apiKey,
					},
				}
				sb, _ := json.Marshal(sub)
				if err := conn.Write(ctx, websocket.MessageText, sb); err != nil {
					appendLog("[mobula] subscribe err: %v", err)
					return
				}
				// pace the writes so Mobula doesn't drop them
				time.Sleep(40 * time.Millisecond)
			}
		}
		appendLog("[mobula] subscribed total=%d markets (trade+price)", len(subscribed))
	}

	if initial := currentBasket(); len(initial) > 0 {
		subscribeMissing(initial)
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ms := <-basketCh:
				subscribeMissing(ms)
			}
		}
	}()

	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var m map[string]interface{}
		if err := json.Unmarshal(b, &m); err != nil {
			continue
		}
		evt, _ := m["event"].(string)
		switch evt {
		case "subscribed":
			continue
		case "error":
			s := string(b)
			if len(s) > 200 {
				s = s[:200]
			}
			fetchErrors.WithLabelValues("mobula", "polymarket", "server_error").Inc()
			appendLog("[mobula] error frame: %s", s)
			continue
		case "pm-market-trade":
			handleMobulaTrade(m)
		case "pm-market-price":
			handleMobulaPrice(m)
		}
	}
}

// Mobula's pm-market-trade payload is a flat object (no nested `data` on
// outbound), e.g.
//   {"event":"pm-market-trade","marketId":"0xabc...","outcomeId":"60526...",
//    "type":"buy","priceUSD":0.7,"sizeToken":12.34,"amountUsd":"8.64","date":1780...}
// Mobula's pm-market-price is similar but carries priceUSD/bestBid/bestAsk
// without size — we still record it as a "price" arrival for correlation
// against Polymarket `price_change`.
func handleMobulaTrade(m map[string]interface{}) {
	eventsTotal.WithLabelValues("mobula", "polymarket", "trade").Inc()
	health.WithLabelValues("mobula", "polymarket").Set(1)
	markAlive("mobula", "polymarket")

	mid, _ := m["marketId"].(string)
	cid := strings.ToLower(mid)
	if cid == "" {
		return
	}
	priceUSD, _ := m["priceUSD"].(float64)
	ts := readMs(m, "date", "timestamp")
	now := nowSec()
	sig := EventSig{
		Venue:       "polymarket",
		ConditionId: cid,
		PriceMilli:  int(priceUSD*1000 + 0.5),
		BucketSec:   bucketSec(ts / 1000.0),
	}
	logSigSample("mobula", sig)
	correlator.Add(sig, Arrival{Provider: "mobula", Kind: "trade", RecvUnix: now})
}

func handleMobulaPrice(m map[string]interface{}) {
	eventsTotal.WithLabelValues("mobula", "polymarket", "price").Inc()
	health.WithLabelValues("mobula", "polymarket").Set(1)
	markAlive("mobula", "polymarket")

	mid, _ := m["marketId"].(string)
	cid := strings.ToLower(mid)
	if cid == "" {
		return
	}
	priceUSD, _ := m["priceUSD"].(float64)
	ts := readMs(m, "timestamp", "date")
	now := nowSec()
	correlator.Add(EventSig{
		Venue:       "polymarket",
		ConditionId: cid,
		PriceMilli:  int(priceUSD*1000 + 0.5),
		BucketSec:   bucketSec(ts / 1000.0),
	}, Arrival{Provider: "mobula", Kind: "price", RecvUnix: now})
}

func readMs(m map[string]interface{}, keys ...string) float64 {
	for _, k := range keys {
		if v, ok := m[k].(float64); ok {
			return v
		}
		if s, ok := m[k].(string); ok {
			return parseF(s)
		}
	}
	return 0
}
