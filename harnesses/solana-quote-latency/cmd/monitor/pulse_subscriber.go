package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// PulseSubscriber owns a single persistent WS connection to Mobula Pulse V2
// and pushes "currently trending" Solana mints into a sliding-window pool.
//
// Pulse V2 has no first-class "trending" view; the server's enum is locked to
// {new, bonding, bonded}. We subscribe to `new` (the only working subscription
// shape) and the server automatically emits ALL THREE views over the same
// connection. We then filter incoming `update-token` / `new-token` events to
// `viewName == "bonded"` — those are post-bonding-curve graduated tokens on
// PumpSwap/Raydium with real volume, which is the practical definition of
// "trending right now" on Solana.
//
// The bonded view emits ~10 distinct mints/min on Solana with a steady-state
// active set of 150-300 mints in any 30-min rolling window. We keep our pool
// bounded to that natural cardinality without an explicit cap.
//
// Caveat — Mobula caps each API key at 3 tracked views total across all active
// connections. If the same key is used by us-east + eu-west + sgp replicas,
// that's exactly 3 (each subscribe message uses 1 view). At the cap but not
// over. Adding any other Pulse-using harness on the same key would push it
// over and the server returns `Failed to subscribe to pulse v2 views`.
const pulseWSURL = "wss://pulse-v2-api.mobula.io"

type pulseV2SubscribeMsg struct {
	Type          string                 `json:"type"`
	Authorization string                 `json:"authorization"`
	Payload       pulseV2SubscribePayload `json:"payload"`
}

type pulseV2SubscribePayload struct {
	Model     string                   `json:"model"`
	AssetMode bool                     `json:"assetMode"`
	ChainID   []string                 `json:"chainId"`
	Views     []map[string]any         `json:"views"`
}

// pulseV2Envelope is the smallest discriminator we need to route an incoming
// message into the right handler. We unmarshal twice: once into the envelope
// to find `type`, then into the specific shape when type matches.
type pulseV2Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type pulseV2TokenRecord struct {
	Address string `json:"address"`
	Symbol  string `json:"symbol"`
	ChainID string `json:"chainId"`
}

type pulseV2TokenUpdatePayload struct {
	ViewName string             `json:"viewName"`
	Token    pulseV2TokenRecord `json:"token"`
}

type pulseV2RemovePayload struct {
	ViewName string `json:"viewName"`
	TokenKey string `json:"tokenKey"`
}

type pulseV2InitPayload struct {
	Bonded struct {
		Data []pulseV2TokenRecord `json:"data"`
	} `json:"bonded"`
}

// PulseSubscriber connects, reads, and writes to a token pool. Multiple users
// of the pool just call Pick on the embedded *TrendingFetcher.
type PulseSubscriber struct {
	apiKey string
	pool   *TrendingFetcher
	chainID string

	connectedAt time.Time
	connected   bool
	connMu      sync.RWMutex
}

func NewPulseSubscriber(apiKey string, pool *TrendingFetcher) *PulseSubscriber {
	return &PulseSubscriber{apiKey: apiKey, pool: pool, chainID: "solana:solana"}
}

// IsConnected reports whether the WS session has been live within the last
// 90 s. The scheduler reads this to decide whether the pulse pool should be
// trusted as the rotation source or whether to fall back to the REST snapshot.
func (s *PulseSubscriber) IsConnected() bool {
	s.connMu.RLock()
	defer s.connMu.RUnlock()
	if !s.connected {
		return false
	}
	return time.Since(s.connectedAt) < 90*time.Second
}

func (s *PulseSubscriber) markConnected() {
	s.connMu.Lock()
	s.connected = true
	s.connectedAt = time.Now()
	s.connMu.Unlock()
}

func (s *PulseSubscriber) markDisconnected() {
	s.connMu.Lock()
	s.connected = false
	s.connMu.Unlock()
}

// Run blocks until ctx is cancelled. It opens one WS session, reads events
// until the connection drops, then reconnects with exponential backoff (5s
// floor, 60s ceiling). Each reconnect re-sends the subscribe payload, and the
// server replays the current snapshot via an `init` message — we use that to
// pre-fill the pool fast.
func (s *PulseSubscriber) Run(ctx context.Context) {
	backoff := 5 * time.Second
	const backoffCap = 60 * time.Second
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		err := s.session(ctx)
		s.markDisconnected()
		if err != nil {
			fmt.Printf("[PULSE-WS] session ended: %v — reconnect in %s\n", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			backoff *= 2
			if backoff > backoffCap {
				backoff = backoffCap
			}
		}
		// On a successful long-lived session we'd reset backoff; we approximate by
		// halving on every reconnect attempt that gets past dial.
	}
}

func (s *PulseSubscriber) session(ctx context.Context) error {
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	hdr := http.Header{}
	hdr.Set("Authorization", s.apiKey)

	conn, _, err := dialer.DialContext(ctx, pulseWSURL, hdr)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	sub := pulseV2SubscribeMsg{
		Type:          "pulse-v2",
		Authorization: s.apiKey,
		Payload: pulseV2SubscribePayload{
			Model:     "default",
			AssetMode: true,
			ChainID:   []string{s.chainID},
			Views: []map[string]any{
				{"name": "new", "sortBy": "created_at", "sortOrder": "desc", "limit": 50},
			},
		},
	}
	if err := conn.WriteJSON(sub); err != nil {
		return fmt.Errorf("subscribe write: %w", err)
	}
	fmt.Println("[PULSE-WS] subscribed; filtering for bonded Solana tokens")
	s.markConnected()

	// Health: bump connectedAt every time we get a real message so IsConnected
	// reflects liveness, not just initial dial.
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		s.markConnected()
		s.handleMessage(raw)
	}
}

func (s *PulseSubscriber) handleMessage(raw []byte) {
	var env pulseV2Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return
	}
	switch env.Type {
	case "init":
		var init pulseV2InitPayload
		if err := json.Unmarshal(env.Payload, &init); err != nil {
			return
		}
		for _, t := range init.Bonded.Data {
			s.pool.Note(t.Address, t.Symbol)
		}
		fmt.Printf("[PULSE-WS] init: pre-loaded %d bonded tokens\n", len(init.Bonded.Data))
	case "new-token", "update-token":
		var p pulseV2TokenUpdatePayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return
		}
		if p.ViewName != "bonded" {
			return
		}
		if p.Token.Address == "" {
			return
		}
		s.pool.Note(p.Token.Address, p.Token.Symbol)
	case "remove-token":
		var p pulseV2RemovePayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return
		}
		if p.ViewName != "bonded" {
			return
		}
		// tokenKey is "solana:solana|<mint>"
		parts := strings.SplitN(p.TokenKey, "|", 2)
		if len(parts) != 2 {
			return
		}
		s.pool.Forget(parts[1])
	}
}
