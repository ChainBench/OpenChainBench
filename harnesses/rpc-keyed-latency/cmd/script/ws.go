package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// The WebSocket arm of the keyed cohort.
//
// Why it lives in this binary rather than its own: the headline metric is a
// race. For one block, which provider pushed it first? Arrival times from
// separate processes would compare clocks as much as providers, and the
// differences we are measuring are tens of milliseconds. One process, one
// clock, every provider on the same chain.
//
// What it deliberately does NOT publish is time-to-first-head. A discovery run
// measured 7 to 11 seconds on Ethereum and 240 to 490 ms on Robinhood Chain
// for every provider alike, because that number is the chain's block time with
// a provider's name attached. The race cancels block time out: all providers
// wait for the same block, so only the spread between them is theirs.
//
// Four things are published instead:
//   subscribe round trip   the provider answering eth_subscribe, their latency
//   head lead              ms behind the first provider to push that block
//   first-to-push count    how often they won, over how many blocks they saw
//   socket round trip      a call on the already-open socket, the WS analogue
//                          of the HTTP warm arm
// plus connection stability, which nobody publishes and which is what actually
// breaks a production bot.

var (
	wsSubscribeMs = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_ws_subscribe_milliseconds",
			Help: "Round trip for eth_subscribe(newHeads) / slotSubscribe on a freshly opened keyed WebSocket.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	// Buckets copied from bench 081, which solved this first and for a reason
	// worth repeating: the winner reads 0 by construction, so a coarse first
	// bucket collapses every leader's p50 into an interpolation artifact
	// inside it. A 1 ms floor is not enough either, hence 0.5. The range runs
	// to 10 s to cover a straggler on a 12 s Ethereum block.
	//
	// The HTTP arm's buckets start at 50 ms and cannot resolve any of this.
	wsHeadLeadHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "rpc_ws_head_lead_milliseconds_histogram",
			Help: "Milliseconds behind the first provider to push a given block. 0 means it won the race.",
			Buckets: []float64{
				0.5, 1, 2, 3, 5, 8, 12, 20, 35, 60,
				100, 160, 260, 420, 680, 1100, 1800, 3000, 5000, 10000,
			},
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsHeadLeadMs = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_ws_head_lead_milliseconds",
			Help: "Latest observed milliseconds behind the first provider to push a block.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsHeadFirstTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_ws_head_first_total",
			Help: "Blocks this provider pushed before every other provider on the same chain.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsHeadSeenTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_ws_head_seen_total",
			Help: "Blocks this provider pushed at all. Denominator for the first-to-push rate.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsCallMs = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_ws_call_milliseconds",
			Help: "Round trip for eth_blockNumber / getSlot sent on an already-open keyed WebSocket.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsCallHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "rpc_ws_call_milliseconds_histogram",
			Help:    "Histogram of calls on an open keyed WebSocket, for p50/p90/p99.",
			Buckets: []float64{1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 250, 500, 1000, 2500},
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsConnected = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_ws_connected",
			Help: "1 while the keyed WebSocket is open and subscribed, 0 otherwise.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	wsDisconnectTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_ws_disconnect_total",
			Help: "Times the keyed WebSocket dropped and had to be reopened.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	// Message volume, because a subscription is billed per push on some plans
	// and a quiet cost overrun is the failure mode nobody watches for. Nine
	// chains at 12 s blocks is roughly 7k messages a day per endpoint.
	wsMessagesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_ws_messages_total",
			Help: "Frames received on keyed WebSockets, for cost accounting.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)
)

// wsEndpoint is one (provider × chain) WebSocket cell, declared the same way
// the HTTP ones are: explicitly, one env var per cell. Deriving wss:// from the
// HTTP variable would be convenient and is exactly how a probe ends up
// measuring something other than what the page claims, so the URL is never
// guessed here.
type wsEndpoint struct {
	Provider string
	Chain    string
	Kind     string
	URL      string
}

func wsEnvURL(provider, chain string) string {
	key := fmt.Sprintf("RPC_KEYED_WS_%s_%s", strings.ToUpper(provider), strings.ToUpper(chain))
	v := strings.TrimSpace(os.Getenv(key))
	switch strings.ToLower(v) {
	case "", "disabled", "off", "-":
		return ""
	}
	if !strings.HasPrefix(v, "ws://") && !strings.HasPrefix(v, "wss://") {
		fmt.Printf("[ws][config] %s ignored: not a ws(s) URL\n", key)
		return ""
	}
	return v
}

func wsEndpoints() []wsEndpoint {
	var out []wsEndpoint
	for _, p := range providers {
		for _, c := range chainsEVM {
			if !chainAllowed(c) {
				continue
			}
			if url := wsEnvURL(p, c); url != "" {
				out = append(out, wsEndpoint{Provider: p, Chain: c, Kind: "evm", URL: url})
			}
		}
		if url := wsEnvURL(p, "solana"); url != "" && chainAllowed("solana") {
			out = append(out, wsEndpoint{Provider: p, Chain: "solana", Kind: "solana", URL: url})
		}
	}
	return out
}

func wsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RPC_KEYED_WS_ENABLE"))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// How long a block stays in the race table. Long enough that a straggler on a
// slow connection still scores, short enough that the map cannot grow.
func raceWindow() time.Duration {
	if v := strings.TrimSpace(os.Getenv("RPC_KEYED_WS_RACE_WINDOW_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 5 {
			return time.Duration(n) * time.Second
		}
	}
	return 60 * time.Second
}

// headRace holds, per chain and block, when the first provider pushed it.
//
// The entry is created by whoever arrives first, so the winner always scores 0
// and everyone else scores their own distance from it. That makes the metric
// relative and therefore immune to block time, which is the whole point.
type headRace struct {
	mu    sync.Mutex
	first map[string]time.Time // "chain/blocknumber" -> first arrival
	order []raceKey            // insertion order, for eviction
}

type raceKey struct {
	key string
	at  time.Time
}

var race = &headRace{first: map[string]time.Time{}}

// observe records an arrival and returns how far behind the leader it was.
func (h *headRace) observe(chain string, number *big.Int, at time.Time) time.Duration {
	k := chain + "/" + number.String()
	h.mu.Lock()
	defer h.mu.Unlock()

	cutoff := at.Add(-raceWindow())
	for len(h.order) > 0 && h.order[0].at.Before(cutoff) {
		delete(h.first, h.order[0].key)
		h.order = h.order[1:]
	}

	if t0, ok := h.first[k]; ok {
		return at.Sub(t0)
	}
	h.first[k] = at
	h.order = append(h.order, raceKey{key: k, at: at})
	return 0
}

func (e wsEndpoint) labels() []string {
	return []string{e.Provider, e.Chain, currentRegion, "keyed"}
}

func (e wsEndpoint) subscribeMsg() []byte {
	if e.Kind == "solana" {
		return []byte(`{"jsonrpc":"2.0","id":1,"method":"slotSubscribe","params":[]}`)
	}
	return []byte(`{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}`)
}

func (e wsEndpoint) callMsg(id int) []byte {
	if e.Kind == "solana" {
		return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"getSlot","params":[{"commitment":"processed"}]}`, id))
	}
	return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"eth_blockNumber","params":[]}`, id))
}

// headNumber pulls the sequence number out of a push, whichever convention the
// chain uses. Both are needed and catching only one is how a discovery run
// reported "subscribed but nothing pushed" on every EVM endpoint: Solana sends
// slotNotification with a plain integer, EVM sends eth_subscription with a hex
// block number.
func headNumber(raw []byte) (*big.Int, bool) {
	var msg struct {
		Method string `json:"method"`
		Params struct {
			Result json.RawMessage `json:"result"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil, false
	}
	switch {
	case msg.Method == "eth_subscription":
		var head struct {
			Number string `json:"number"`
		}
		if err := json.Unmarshal(msg.Params.Result, &head); err != nil {
			return nil, false
		}
		n := new(big.Int)
		if _, ok := n.SetString(strings.TrimPrefix(head.Number, "0x"), 16); !ok {
			return nil, false
		}
		return n, true
	case strings.HasSuffix(msg.Method, "Notification"):
		var slot struct {
			Slot uint64 `json:"slot"`
		}
		if err := json.Unmarshal(msg.Params.Result, &slot); err != nil {
			return nil, false
		}
		return new(big.Int).SetUint64(slot.Slot), true
	}
	return nil, false
}

// runWS keeps one endpoint connected for the life of the process, reopening it
// with backoff after a drop and counting every drop, because connection
// stability is a published result here and not just an implementation detail.
func runWS(ctx context.Context, e wsEndpoint) {
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		if err := wsSession(ctx, e); err != nil && ctx.Err() == nil {
			// Redact: a dial error embeds the full URL, which carries the key.
			fmt.Printf("[ws][%s/%s] session ended: %s\n", e.Chain, e.Provider,
				strings.ReplaceAll(err.Error(), e.URL, hostOf(e.URL)))
		}
		wsConnected.WithLabelValues(e.labels()...).Set(0)
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

func wsSession(ctx context.Context, e wsEndpoint) error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		Proxy:            http.ProxyFromEnvironment,
	}
	t0 := time.Now()
	conn, _, err := dialer.DialContext(ctx, e.URL, nil)
	if err != nil {
		wsDisconnectTotal.WithLabelValues(e.labels()...).Inc()
		return err
	}
	defer func() { _ = conn.Close() }()

	if err := conn.WriteMessage(websocket.TextMessage, e.subscribeMsg()); err != nil {
		wsDisconnectTotal.WithLabelValues(e.labels()...).Inc()
		return err
	}

	// A call id per session, above the subscribe id, so a late reply from a
	// previous call cannot be mistaken for the current one.
	callID := 100
	pending := map[int]time.Time{}
	subscribed := false

	callTicker := time.NewTicker(60 * time.Second)
	defer callTicker.Stop()

	// Drive reads from a goroutine so the call ticker is not blocked behind a
	// chain that pushes nothing for a minute.
	type frame struct {
		raw []byte
		at  time.Time
		err error
	}
	frames := make(chan frame, 16)
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			at := time.Now()
			select {
			case frames <- frame{raw: raw, at: at, err: err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-callTicker.C:
			if !subscribed {
				continue
			}
			callID++
			pending[callID] = time.Now()
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, e.callMsg(callID)); err != nil {
				wsDisconnectTotal.WithLabelValues(e.labels()...).Inc()
				return err
			}

		case f := <-frames:
			if f.err != nil {
				wsDisconnectTotal.WithLabelValues(e.labels()...).Inc()
				return f.err
			}
			wsMessagesTotal.WithLabelValues(e.labels()...).Inc()

			// The subscribe acknowledgement, and the only moment the dial
			// timing means anything.
			var ack struct {
				ID     int             `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(f.raw, &ack); err == nil && ack.ID != 0 {
				if ack.Error != nil {
					return fmt.Errorf("rpc error: %s", ack.Error.Message)
				}
				if ack.ID == 1 && !subscribed {
					subscribed = true
					wsConnected.WithLabelValues(e.labels()...).Set(1)
					if egressPublishable() {
						wsSubscribeMs.WithLabelValues(e.labels()...).Set(
							float64(f.at.Sub(t0).Milliseconds()))
					}
					continue
				}
				if sentAt, ok := pending[ack.ID]; ok {
					delete(pending, ack.ID)
					if egressPublishable() {
						ms := float64(f.at.Sub(sentAt).Microseconds()) / 1000
						wsCallMs.WithLabelValues(e.labels()...).Set(ms)
						wsCallHist.WithLabelValues(e.labels()...).Observe(ms)
					}
				}
				continue
			}

			n, ok := headNumber(f.raw)
			if !ok {
				continue
			}
			lead := race.observe(e.Chain, n, f.at)
			// Same rule as the HTTP arm: a sample published under a region
			// label that is not true is worse than no sample.
			if !egressPublishable() {
				continue
			}
			ms := float64(lead.Microseconds()) / 1000
			wsHeadSeenTotal.WithLabelValues(e.labels()...).Inc()
			wsHeadLeadMs.WithLabelValues(e.labels()...).Set(ms)
			wsHeadLeadHist.WithLabelValues(e.labels()...).Observe(ms)
			if lead == 0 {
				wsHeadFirstTotal.WithLabelValues(e.labels()...).Inc()
			}
		}
	}
}

// StartWSLoop opens one long-lived connection per declared cell.
func StartWSLoop(ctx context.Context) {
	if !wsEnabled() {
		fmt.Println("[ws] disabled by RPC_KEYED_WS_ENABLE")
		return
	}
	eps := wsEndpoints()
	if len(eps) == 0 {
		fmt.Println("[ws] no RPC_KEYED_WS_* env vars set — WebSocket arm idle")
		return
	}
	fmt.Printf("[ws] %d endpoints, race window %s\n", len(eps), raceWindow())
	for _, e := range eps {
		go runWS(ctx, e)
	}
}
