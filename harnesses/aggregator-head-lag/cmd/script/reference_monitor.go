package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Reference clock for bench 001.
//
// The published methodology says, in three places, that head lag is
// measured against canonical-tip archive nodes ("Reference: archive nodes
// per chain, validated against block hashes"). The harness never did that:
// both provider paths compute `receiveTime - <the timestamp the provider
// itself sent us>`. Measured consequence, on trades matched by hash: the
// same swap carries timestamps 707 ms apart on Solana and 1,000 ms apart
// on Base depending on which provider you ask, so the leaderboard partly
// ranks where each vendor places its clock rather than how fast its
// pipeline is.
//
// This file supplies the missing reference. One WebSocket subscription per
// monitored pool, straight to a node, timestamping every swap the instant
// it reaches us. Provider emissions are then matched by transaction hash
// against that single clock, so every provider is measured with the same
// ruler.
//
// It publishes a NEW series (head_lag_ref_seconds) next to the existing
// one rather than replacing it. The old series keeps its history and the
// leaderboard keeps working while the two are compared; switching the
// headline is a separate, documented change.

// refWSURL returns the node endpoint for a chain, env-overridable so a
// paid endpoint can replace the public one without a rebuild.
func refWSURL(chainName string) string {
	env := "REF_WS_URL_" + strings.ToUpper(chainName)
	if v := strings.TrimSpace(os.Getenv(env)); v != "" {
		return v
	}
	switch chainName {
	case "base":
		return "wss://base-rpc.publicnode.com"
	case "bnb":
		return "wss://bsc-rpc.publicnode.com"
	case "solana":
		// Measured 2026-09-05 before shipping: publicnode acknowledges
		// logsSubscribe and then delivers nothing (0 events in 60 s on a
		// pool the EVM equivalents were streaming), and drpc rejects the
		// method outright on the free plan ("method is not available on
		// free plan", code 35). mainnet-beta answers and delivers. It is
		// rate limited, so a paid endpoint via REF_WS_URL_SOLANA is the
		// right long-term answer.
		return "wss://api.mainnet-beta.solana.com"
	default:
		// robinhood and anything else: no public endpoint we trust.
		// Leaving it empty disables the reference for that chain rather
		// than silently measuring against something arbitrary.
		return ""
	}
}

type refEntry struct {
	at time.Time
}

type refClock struct {
	mu   sync.RWMutex
	seen map[string]refEntry // "chain|lowercased tx hash" -> our observation time
}

var reference = &refClock{seen: map[string]refEntry{}}

const (
	refTTL         = 10 * time.Minute
	refMaxEntries  = 200000
	refSweepPeriod = 2 * time.Minute
)

func refKey(chain, hash string) string {
	return chain + "|" + strings.ToLower(strings.TrimSpace(hash))
}

func (r *refClock) observe(chain, hash string, at time.Time) {
	if hash == "" {
		return
	}
	r.mu.Lock()
	// Keep the FIRST observation. A log subscription can redeliver on
	// reconnect and a later duplicate would understate every provider's
	// lag on that trade.
	k := refKey(chain, hash)
	if _, ok := r.seen[k]; !ok {
		r.seen[k] = refEntry{at: at}
	}
	r.mu.Unlock()
}

// lookup returns our observation time for a trade, and whether we saw it
// at all. A miss is a miss: the caller must skip the sample rather than
// fall back to the provider's own timestamp, which is the exact defect
// this file exists to remove.
func (r *refClock) lookup(chain, hash string) (time.Time, bool) {
	r.mu.RLock()
	e, ok := r.seen[refKey(chain, hash)]
	r.mu.RUnlock()
	return e.at, ok
}

func (r *refClock) sweep() {
	cutoff := time.Now().Add(-refTTL)
	r.mu.Lock()
	if len(r.seen) > refMaxEntries {
		r.seen = map[string]refEntry{}
		r.mu.Unlock()
		return
	}
	for k, e := range r.seen {
		if e.at.Before(cutoff) {
			delete(r.seen, k)
		}
	}
	r.mu.Unlock()
}

func (r *refClock) size() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.seen)
}

// runReferenceMonitor starts one subscription per monitored pool plus a
// TTL sweeper. Never fatal: a chain without an endpoint, or a node that
// refuses us, simply leaves head_lag_ref_seconds unpopulated for that
// chain while the legacy series keeps running.
func runReferenceMonitor(stopChan <-chan struct{}) {
	fmt.Println("[HEAD-LAG][REF] starting node reference subscriptions")
	go func() {
		t := time.NewTicker(refSweepPeriod)
		defer t.Stop()
		for {
			select {
			case <-stopChan:
				return
			case <-t.C:
				reference.sweep()
				RecordRefClockSize(reference.size())
			}
		}
	}()

	for _, p := range headLagPools {
		url := refWSURL(p.ChainName)
		if url == "" {
			fmt.Printf("[HEAD-LAG][REF][%s] no endpoint configured (set REF_WS_URL_%s), reference disabled for this chain\n",
				p.ChainName, strings.ToUpper(p.ChainName))
			continue
		}
		go refLoop(p, url, stopChan)
	}
}

func refLoop(p HeadLagPool, url string, stopChan <-chan struct{}) {
	backoff := 2 * time.Second
	for {
		select {
		case <-stopChan:
			return
		default:
		}
		err := refConnect(p, url, stopChan)
		if err != nil {
			fmt.Printf("[HEAD-LAG][REF][%s] %v — reconnect in %v\n", p.ChainName, err, backoff)
		}
		select {
		case <-stopChan:
			return
		case <-time.After(backoff):
		}
		if backoff < 60*time.Second {
			backoff *= 2
		}
	}
}

func refConnect(p HeadLagPool, url string, stopChan <-chan struct{}) error {
	// Deliberately NOT getProxyDialer: the reference clock must not share
	// the scraping proxy. A saturated proxy would add its own latency to
	// the reference and silently flatter every provider.
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	var sub any
	if p.ChainName == "solana" {
		sub = map[string]any{
			"jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
			"params": []any{
				map[string]any{"mentions": []string{p.Address}},
				map[string]any{"commitment": "confirmed"},
			},
		}
	} else {
		sub = map[string]any{
			"jsonrpc": "2.0", "id": 1, "method": "eth_subscribe",
			"params": []any{"logs", map[string]any{"address": p.Address}},
		}
	}
	if err := conn.WriteJSON(sub); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	fmt.Printf("[HEAD-LAG][REF][%s] subscribed to %s on %s\n", p.ChainName, p.Address, url)

	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopChan:
				return
			case <-t.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	for {
		select {
		case <-stopChan:
			return nil
		default:
		}
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		now := time.Now().UTC()

		var env struct {
			Method string `json:"method"`
			Params struct {
				Result json.RawMessage `json:"result"`
			} `json:"params"`
		}
		if json.Unmarshal(msg, &env) != nil || len(env.Params.Result) == 0 {
			continue
		}

		if p.ChainName == "solana" {
			var r struct {
				Value struct {
					Signature string `json:"signature"`
					Err       any    `json:"err"`
				} `json:"value"`
			}
			if json.Unmarshal(env.Params.Result, &r) != nil {
				continue
			}
			// Failed transactions never become a swap any provider will
			// emit; counting them would create reference entries that are
			// matched by nobody.
			if r.Value.Err != nil || r.Value.Signature == "" {
				continue
			}
			reference.observe(p.ChainName, r.Value.Signature, now)
			continue
		}

		var r struct {
			TransactionHash string `json:"transactionHash"`
			Removed         bool   `json:"removed"`
		}
		if json.Unmarshal(env.Params.Result, &r) != nil {
			continue
		}
		// A reorged-out log is not a trade.
		if r.Removed || r.TransactionHash == "" {
			continue
		}
		reference.observe(p.ChainName, r.TransactionHash, now)
	}
}
