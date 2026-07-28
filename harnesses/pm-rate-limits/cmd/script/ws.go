package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"log"
	"net/http"
	"strconv"
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

// kalshiWSURL is the Kalshi trading API WebSocket endpoint.
// Requires RSA-PSS-SHA256 signed auth headers; returns 403 from non-US IPs.
const kalshiWSURL = "wss://trading-api.kalshi.com/trade-api/ws/v2"

// kalshiAuthHeaders computes the three headers Kalshi requires for WS auth.
// Signature: RSA-PSS SHA256 over "{timestamp_ms}GET/trade-api/ws/v2".
func kalshiAuthHeaders(keyID, privateKeyPEM string) (http.Header, error) {
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return nil, log.Output(0, "kalshi: invalid PEM block") // surfaces in log
	}
	raw, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		// try PKCS1
		raw, err = func() (any, error) { k, e := x509.ParsePKCS1PrivateKey(block.Bytes); return k, e }()
		if err != nil {
			return nil, err
		}
	}
	rsaKey, ok := raw.(*rsa.PrivateKey)
	if !ok {
		return nil, log.Output(0, "kalshi: key is not RSA")
	}
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	msg := ts + "GET" + "/trade-api/ws/v2"
	h := sha256.Sum256([]byte(msg))
	sig, err := rsa.SignPSS(rand.Reader, rsaKey, crypto.SHA256, h[:], &rsa.PSSOptions{
		SaltLength: rsa.PSSSaltLengthEqualsHash,
	})
	if err != nil {
		return nil, err
	}
	return http.Header{
		"KALSHI-ACCESS-KEY":       {keyID},
		"KALSHI-ACCESS-TIMESTAMP": {ts},
		"KALSHI-ACCESS-SIGNATURE": {base64.StdEncoding.EncodeToString(sig)},
		"User-Agent":              {userAgent},
	}, nil
}

func runKalshiWS(ctx context.Context, st *venueState, keyID, privateKeyPEM string) {
	// Kalshi WS returns 403 from non-US IPs; only probe from us-east.
	if currentRegion != "us-east" {
		log.Printf("[ws][kalshi] skipping region %s (403 from non-US IPs)", currentRegion)
		return
	}
	backoff := 5 * time.Second
	for ctx.Err() == nil {
		pin := st.getPin()
		if pin.Market == "" {
			time.Sleep(5 * time.Second)
			continue
		}
		ok := kalshiWSSession(ctx, st, pin.Market, keyID, privateKeyPEM)
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

func kalshiWSSession(ctx context.Context, st *venueState, ticker, keyID, privateKeyPEM string) bool {
	headers, err := kalshiAuthHeaders(keyID, privateKeyPEM)
	if err != nil {
		log.Printf("[ws][kalshi] auth header error: %v", err)
		return false
	}
	dialStart := time.Now()
	c, _, err := websocket.Dial(ctx, kalshiWSURL, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		log.Printf("[ws][kalshi] dial failed: %v", err)
		return false
	}
	c.SetReadLimit(1 << 22)
	defer c.Close(websocket.StatusNormalClosure, "bye")

	sub, _ := json.Marshal(map[string]any{
		"id":  1,
		"cmd": "subscribe",
		"params": map[string]any{
			"channels":       []string{"ticker"},
			"market_tickers": []string{ticker},
		},
	})
	if err := c.Write(ctx, websocket.MessageText, sub); err != nil {
		log.Printf("[ws][kalshi] subscribe failed: %v", err)
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
				if st.getPin().Market != ticker {
					c.Close(websocket.StatusNormalClosure, "repin")
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
				wsDisconnects.WithLabelValues("kalshi", currentRegion, sourceDirect).Inc()
				log.Printf("[ws][kalshi] disconnected: %v", err)
			}
			return gotData
		}
		// Skip subscription confirmation, only count actual ticker data frames.
		var msg struct {
			Type string `json:"type"`
		}
		if jsonErr := json.Unmarshal(data, &msg); jsonErr == nil && msg.Type == "subscribed" {
			continue
		}
		now := time.Now()
		if !gotData {
			gotData = true
			wsConnectToSnapshot.WithLabelValues("kalshi", currentRegion, sourceDirect).Observe(now.Sub(dialStart).Seconds())
		} else if !lastMsg.IsZero() {
			wsInterarrival.WithLabelValues("kalshi", currentRegion, sourceDirect).Observe(now.Sub(lastMsg).Seconds())
		}
		lastMsg = now
	}
}
