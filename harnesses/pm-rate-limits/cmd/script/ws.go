package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"nhooyr.io/websocket"
)

// Polymarket is the only cohort venue with a public, timestamped market WS:
// Kalshi requires auth (absent by design, badged in the spec), Manifold and
// Myriad have none, Limitless is socket.io. Pattern vendored from
// pm-freshness-bench: subscribe by asset id, literal "PING" keepalive.
const polymarketWSURL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

func runPolymarketWS(ctx context.Context, st *venueState) {
	backoff := 5 * time.Second
	for ctx.Err() == nil {
		pin := st.getPin()
		if pin.Token == "" {
			time.Sleep(5 * time.Second)
			continue
		}
		ok := wsSession(ctx, st, pin.Token)
		if ok {
			backoff = 5 * time.Second
		} else {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}

// wsSession returns true if the session got at least one data frame.
func wsSession(ctx context.Context, st *venueState, token string) bool {
	dialStart := time.Now()
	c, _, err := websocket.Dial(ctx, polymarketWSURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"User-Agent": {userAgent}},
	})
	if err != nil {
		log.Printf("[ws][polymarket] dial failed: %v", err)
		return false
	}
	c.SetReadLimit(1 << 22)
	defer c.Close(websocket.StatusNormalClosure, "bye")

	sub, _ := json.Marshal(map[string]any{"assets_ids": []string{token}, "type": "market"})
	if err := c.Write(ctx, websocket.MessageText, sub); err != nil {
		log.Printf("[ws][polymarket] subscribe failed: %v", err)
		return false
	}

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				if st.getPin().Token != token {
					// Pin changed: drop the session, the outer loop resubscribes.
					c.Close(websocket.StatusNormalClosure, "repin")
					return
				}
				if err := c.Write(sctx, websocket.MessageText, []byte("PING")); err != nil {
					return
				}
			}
		}
	}()

	gotData := false
	var lastMsg time.Time
	for {
		_, data, err := c.Read(sctx)
		if err != nil {
			if gotData && ctx.Err() == nil {
				wsDisconnects.WithLabelValues("polymarket", currentRegion, sourceDirect).Inc()
				log.Printf("[ws][polymarket] disconnected: %v", err)
			}
			return gotData
		}
		if string(data) == "PONG" {
			continue
		}
		now := time.Now()
		if !gotData {
			gotData = true
			wsConnectToSnapshot.WithLabelValues("polymarket", currentRegion, sourceDirect).Observe(now.Sub(dialStart).Seconds())
		} else if !lastMsg.IsZero() {
			wsInterarrival.WithLabelValues("polymarket", currentRegion, sourceDirect).Observe(now.Sub(lastMsg).Seconds())
		}
		lastMsg = now
	}
}
