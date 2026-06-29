package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const polymarketWS = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

func runPolymarket(ctx context.Context, basketCh <-chan []Market) {
	// Maps clobTokenId → conditionId, refreshed from each basket update.
	// Polymarket WS keys events by `asset_id` (= clobTokenId). The correlator
	// keys by conditionId, so we need this mapping in O(1) on the hot path.
	var (
		idMu       sync.RWMutex
		assetToCID = map[string]string{}
	)

	updateMap := func(ms []Market) {
		idMu.Lock()
		defer idMu.Unlock()
		assetToCID = map[string]string{}
		for _, m := range ms {
			for _, aid := range m.ClobTokenIds {
				assetToCID[aid] = strings.ToLower(m.ConditionId)
			}
		}
	}

	lookupCID := func(assetId string) string {
		idMu.RLock()
		defer idMu.RUnlock()
		return assetToCID[assetId]
	}

	// Reconnect loop. On every connection we read the current basket and
	// resubscribe with the full asset list.
	backoff := 5 * time.Second
	for ctx.Err() == nil {
		err := dialAndStream(ctx, basketCh, updateMap, lookupCID)
		if ctx.Err() != nil {
			return
		}
		appendLog("[poly] connection ended: %v — reconnecting in %v", err, backoff)
		fetchErrors.WithLabelValues("polymarket", "polymarket", classify(err)).Inc()
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func dialAndStream(ctx context.Context, basketCh <-chan []Market, onBasket func([]Market), lookupCID func(string) string) error {
	conn, _, err := websocket.Dial(ctx, polymarketWS, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusInternalError, "")
	conn.SetReadLimit(8 * 1024 * 1024)

	subscribed := map[string]bool{} // assetId -> true

	subscribeMissing := func(ms []Market) {
		assetIds := []string{}
		for _, m := range ms {
			for _, aid := range m.ClobTokenIds {
				if !subscribed[aid] {
					assetIds = append(assetIds, aid)
					subscribed[aid] = true
				}
			}
		}
		if len(assetIds) == 0 {
			return
		}
		sub := map[string]interface{}{
			"assets_ids":             assetIds,
			"type":                   "market",
			"custom_feature_enabled": true,
		}
		sb, _ := json.Marshal(sub)
		if err := conn.Write(ctx, websocket.MessageText, sb); err != nil {
			appendLog("[poly] subscribe write err: %v", err)
			return
		}
		appendLog("[poly] subscribed +%d assets (total=%d)", len(assetIds), len(subscribed))
	}

	// initial basket
	initial := currentBasket()
	if len(initial) > 0 {
		onBasket(initial)
		subscribeMissing(initial)
	}

	// ping loop (server expects literal text "PING" every 10s)
	pingCtx, pingCancel := context.WithCancel(ctx)
	defer pingCancel()
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
				if err := conn.Write(pingCtx, websocket.MessageText, []byte("PING")); err != nil {
					return
				}
			}
		}
	}()

	// basket-update goroutine — react to new markets coming in
	go func() {
		for {
			select {
			case <-pingCtx.Done():
				return
			case ms := <-basketCh:
				onBasket(ms)
				subscribeMissing(ms)
			}
		}
	}()

	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if bytes.Equal(b, []byte("PONG")) {
			continue
		}
		t := bytes.TrimSpace(b)
		var arr []map[string]interface{}
		if len(t) > 0 && t[0] == '[' {
			json.Unmarshal(b, &arr)
		} else {
			var one map[string]interface{}
			if json.Unmarshal(b, &one) == nil {
				arr = []map[string]interface{}{one}
			}
		}
		for _, ev := range arr {
			eventType, _ := ev["event_type"].(string)
			tsMs, _ := parseTimestampMsField(ev["timestamp"])
			assetId, _ := ev["asset_id"].(string)
			cid := lookupCID(assetId)
			if cid == "" {
				continue
			}
			now := nowSec()
			switch eventType {
			case "last_trade_price":
				eventsTotal.WithLabelValues("polymarket", "polymarket", "trade").Inc()
				price, _ := ev["price"].(string)
				health.WithLabelValues("polymarket", "polymarket").Set(1)
				markAlive("polymarket", "polymarket")
				sig := EventSig{
					Venue:       "polymarket",
					ConditionId: cid,
					PriceMilli:  priceToMilli(price),
					BucketSec:   bucketSec(tsMs / 1000.0),
				}
				logSigSample("polymarket", sig)
				correlator.Add(sig, Arrival{Provider: "polymarket", Kind: "trade", RecvUnix: now})
			case "price_change":
				eventsTotal.WithLabelValues("polymarket", "polymarket", "price").Inc()
				health.WithLabelValues("polymarket", "polymarket").Set(1)
				markAlive("polymarket", "polymarket")
				if changes, ok := ev["price_changes"].([]interface{}); ok {
					for _, ch := range changes {
						chm, _ := ch.(map[string]interface{})
						if chm == nil {
							continue
						}
						price, _ := chm["price"].(string)
						correlator.Add(EventSig{
							Venue:       "polymarket",
							ConditionId: cid,
							PriceMilli:  priceToMilli(price),
							BucketSec:   bucketSec(tsMs / 1000.0),
						}, Arrival{Provider: "polymarket", Kind: "price", RecvUnix: now})
					}
				}
			}
		}
	}
}

// Polymarket emits `timestamp` as a string of ms-since-epoch. Codex emits
// it as an int seconds-since-epoch. Mobula emits it as a number of ms.
// Normalize to ms float here.
func parseTimestampMsField(v interface{}) (float64, error) {
	switch t := v.(type) {
	case string:
		return parseF(t), nil
	case float64:
		return t, nil
	case int64:
		return float64(t), nil
	}
	return 0, fmt.Errorf("unknown timestamp type")
}
