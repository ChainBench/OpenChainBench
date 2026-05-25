package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Solana mainnet-beta public WebSocket endpoint. Verified live no-key
// for `logsSubscribe(mentions=[wallet])`, ~97 events/sec stable over
// 2-minute probes. Override via env when needed.
const defaultSolanaWS = "wss://api.mainnet-beta.solana.com"

// dedupCacheSize bounds the LRU of recently-seen signatures so we
// don't double-count on reconnect (Solana WS replays a few seconds of
// notifications on resubscribe). 50k entries × 88 bytes/sig = ~4 MB
// memory, covers ~1 minute of attributed traffic at peak.
const dedupCacheSize = 50000

// reconnectBackoffMax caps the exponential backoff so we recover
// quickly after a long outage instead of waiting 30+ minutes.
const reconnectBackoffMax = 60 * time.Second

// rpcReq is the JSON-RPC request envelope used for logsSubscribe.
type rpcReq struct {
	Jsonrpc string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

// rpcResp covers both subscription confirmations and notifications.
// Confirmation: `result` is the subscription id (number).
// Notification: `method` = "logsNotification", `params.result.value` has
// the signature + err + logs.
type rpcResp struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      int             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Params  *struct {
		Subscription int             `json:"subscription"`
		Result       json.RawMessage `json:"result"`
	} `json:"params,omitempty"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// logsNotification is the inner shape of a logsSubscribe event.
type logsNotification struct {
	Context struct {
		Slot uint64 `json:"slot"`
	} `json:"context"`
	Value struct {
		Signature string   `json:"signature"`
		Err       any      `json:"err"`
		Logs      []string `json:"logs"`
	} `json:"value"`
}

// dedup is a tiny ring-buffer LRU keyed by signature. Concurrent-safe.
type dedup struct {
	mu   sync.Mutex
	seen map[string]struct{}
	ring []string
	cap  int
}

func newDedup(cap int) *dedup {
	return &dedup{seen: make(map[string]struct{}, cap), ring: make([]string, 0, cap), cap: cap}
}

// add returns true if the signature is new (and inserts it), false if
// it was already seen recently.
func (d *dedup) add(sig string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[sig]; ok {
		return false
	}
	d.seen[sig] = struct{}{}
	d.ring = append(d.ring, sig)
	if len(d.ring) > d.cap {
		// Evict the oldest.
		old := d.ring[0]
		d.ring = d.ring[1:]
		delete(d.seen, old)
	}
	return true
}

// subIDToService maps the WS subscription id (assigned by the server
// after each logsSubscribe call) back to the service it covers. Used
// by the notification handler to know which counter to increment.
type subIDIndex struct {
	mu sync.RWMutex
	m  map[int]Service
}

func newSubIDIndex() *subIDIndex {
	return &subIDIndex{m: make(map[int]Service)}
}

func (s *subIDIndex) set(id int, svc Service) {
	s.mu.Lock()
	s.m[id] = svc
	s.mu.Unlock()
}

func (s *subIDIndex) get(id int) (Service, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.m[id]
	return v, ok
}

// runSubscriber maintains the WS subscription. On disconnect it backs
// off and resubscribes everything. Blocking call — run in its own
// goroutine. Each tip wallet gets its own logsSubscribe call so the
// notification flow stays sharded server-side (lower bandwidth, easy
// to attribute).
func runSubscriber(ctx context.Context, wsURL string) {
	d := newDedup(dedupCacheSize)
	backoff := 2 * time.Second

	for ctx.Err() == nil {
		err := runOneConnection(ctx, wsURL, d)
		if ctx.Err() != nil {
			return
		}
		fmt.Printf("[ws] disconnected: %v — reconnecting in %s\n", err, backoff)
		solanaLandingReconnects.Inc()
		// Mark every service unhealthy until we reconnect + resubscribe.
		for svc := range walletsByService() {
			solanaLandingSubHealth.WithLabelValues(string(svc)).Set(0)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > reconnectBackoffMax {
			backoff = reconnectBackoffMax
		}
	}
}

// runOneConnection holds one WS session: dial, subscribe to every
// wallet, dispatch every notification. Returns when the connection
// dies or ctx is done. Caller handles reconnect.
func runOneConnection(ctx context.Context, wsURL string, d *dedup) error {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
		return nil
	})

	subIdx := newSubIDIndex()
	pendingID := make(map[int]Service) // reqID → service awaiting subscription ack
	wallets := walletsByService()

	// Subscribe one wallet at a time so we can map req-id → service.
	// logsSubscribe params: {"mentions":[<addr>]}, commitment "confirmed".
	reqID := 1
	for svc, ws := range wallets {
		for _, w := range ws {
			req := rpcReq{
				Jsonrpc: "2.0",
				ID:      reqID,
				Method:  "logsSubscribe",
				Params: []any{
					map[string]any{"mentions": []string{w}},
					map[string]any{"commitment": "confirmed"},
				},
			}
			if err := conn.WriteJSON(req); err != nil {
				return fmt.Errorf("subscribe: %w", err)
			}
			pendingID[reqID] = svc
			reqID++
		}
	}

	// Keepalive ping every 30 s; mainnet-beta closes idle sockets at 5min.
	stopPing := make(chan struct{})
	defer close(stopPing)
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopPing:
				return
			case <-t.C:
				_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			}
		}
	}()

	for ctx.Err() == nil {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		var resp rpcResp
		if err := json.Unmarshal(raw, &resp); err != nil {
			continue
		}
		if resp.Error != nil {
			fmt.Printf("[ws] rpc error: %d %s\n", resp.Error.Code, resp.Error.Message)
			continue
		}
		// Subscription ack: bind result (subscription id) to the
		// service we requested it for, then mark that service healthy.
		if resp.ID != 0 && resp.Params == nil {
			var subID int
			if err := json.Unmarshal(resp.Result, &subID); err != nil {
				continue
			}
			if svc, ok := pendingID[resp.ID]; ok {
				subIdx.set(subID, svc)
				solanaLandingSubHealth.WithLabelValues(string(svc)).Set(1)
				delete(pendingID, resp.ID)
			}
			continue
		}
		// Notification: route by subscription id, dedup, count.
		if resp.Method == "logsNotification" && resp.Params != nil {
			svc, ok := subIdx.get(resp.Params.Subscription)
			if !ok {
				continue
			}
			var note logsNotification
			if err := json.Unmarshal(resp.Params.Result, &note); err != nil {
				continue
			}
			// Skip failed tx — they didn't actually land successfully.
			// `Err` is null on success.
			if note.Value.Err != nil {
				continue
			}
			if !d.add(note.Value.Signature) {
				continue
			}
			solanaLandingTxTotal.WithLabelValues(string(svc)).Inc()
			solanaLandingLastSlot.WithLabelValues(string(svc)).Set(float64(note.Context.Slot))
		}
	}
	return ctx.Err()
}
