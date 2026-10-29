package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// Second Base reference source: the sequencer's preconfirmation node.
//
// base_flashblock_ref.go put the zero point on the flashblocks stream, which
// was right and is still the main source. What it did not account for is that
// `mainnet.flashblocks.base.org` sits behind Cloudflare and carries a tail:
// measured 2026-10-27 from three Railway regions, 170 to 220 ms on the slow
// decile, and in Singapore it ran about 19 ms behind Base's own preconf node
// on every one of 88 trades.
//
// That tail is not cosmetic. A reference that is late flatters every provider
// measured against it, and by 2026-10-29 Codex on Base was arriving before our
// own reference on more races than it lost, which means the zero point had
// stopped bounding the field. A ruler a competitor beats is not a ruler.
//
// So this subscribes to `eth_subscribe pendingLogs` on the sequencer node and
// feeds the SAME clock. refClock.observeFirst keeps the earliest observation,
// so the Base zero point becomes min(flashblocks, preconf) per transaction.
//
// Why that makes the change safe rather than a gamble: a second source can
// only move the zero point earlier. On any trade where this node is slower,
// its sample is discarded and the reference is exactly what it was before.
// Measured from a residential line in France on 2026-10-29, preconf was first
// on 41 % of 4289 transactions, at p90 some 181 ms earlier and at the median 8
// ms later, which is the expected shape: it removes the flashblocks tail and
// does nothing on the trades flashblocks already handled promptly.
//
// What it changes for readers: every provider's Base head lag gets LARGER,
// because the instant the information became public moved earlier. The
// first-to-report shares do not move, since the race is between providers and
// the reference is not a competitor in it.
//
// No address filter, deliberately. The flashblocks reference observes every
// transaction on the chain, so this one has to as well or it would only ever
// win on the handful it happened to cover. Filtered to the bench's own pool
// this endpoint delivers about one event per 75 s, which is the pool being
// quiet; unfiltered it delivers about 236 logs per second, and the duplicate
// hashes across logs of one transaction cost nothing because the clock keeps
// the first.

const basePreconfDefaultURL = "wss://mainnet-preconf.base.org"

func basePreconfURL() string {
	if v, ok := os.LookupEnv("BASE_PRECONF_WS_URL"); ok {
		return strings.TrimSpace(v)
	}
	return basePreconfDefaultURL
}

// runBasePreconfReference feeds the shared reference clock from Base's
// sequencer preconfirmation node. Never fatal, exactly like the flashblocks
// source: if this endpoint is unreachable the Base reference simply falls back
// to being what it was before this file existed.
func runBasePreconfReference(stopChan <-chan struct{}) {
	url := basePreconfURL()
	if url == "" {
		log.Printf("[HEAD-LAG][REF][base] preconf disabled (empty URL)")
		return
	}
	delay := 2 * time.Second
	const maxDelay = 60 * time.Second
	for {
		select {
		case <-stopChan:
			return
		default:
		}
		if err := basePreconfConnect(url, stopChan); err != nil {
			log.Printf("[HEAD-LAG][REF][base] preconf: %v (retry in %v)", err, delay)
			select {
			case <-stopChan:
				return
			case <-time.After(delay):
			}
			if delay *= 2; delay > maxDelay {
				delay = maxDelay
			}
			continue
		}
		delay = 2 * time.Second
	}
}

func basePreconfConnect(url string, stopChan <-chan struct{}) error {
	// Plain dialer for the same reason as refConnect and the flashblocks
	// source: the scraping proxy would add its own latency to the reference
	// and flatter every provider measured against it.
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	sub := map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "eth_subscribe",
		"params": []any{"pendingLogs", map[string]any{}},
	}
	if err := conn.WriteJSON(sub); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	fmt.Printf("[HEAD-LAG][REF][base] preconf subscribed to pendingLogs on %s\n", url)

	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopChan:
				return
			case <-t.C:
				if err := conn.WriteControl(websocket.PingMessage, nil,
					time.Now().Add(5*time.Second)); err != nil {
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
		// Generous next to the flashblocks 30 s: this is a log stream on a
		// chain-wide filter, so a gap means trouble, but the node has been
		// seen to close with "upstream went away" and reconnecting is the
		// correct response rather than treating it as a dead reference.
		_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		seen := time.Now().UTC()

		var env struct {
			Error  json.RawMessage `json:"error"`
			Params struct {
				Result json.RawMessage `json:"result"`
			} `json:"params"`
		}
		if json.Unmarshal(msg, &env) != nil {
			continue
		}
		if len(env.Error) > 0 {
			return fmt.Errorf("subscription rejected: %s", string(env.Error))
		}
		if len(env.Params.Result) == 0 {
			continue
		}
		var lg struct {
			TransactionHash string `json:"transactionHash"`
		}
		if json.Unmarshal(env.Params.Result, &lg) != nil || lg.TransactionHash == "" {
			continue
		}
		if reference.observeFirst("base", lg.TransactionHash, seen) {
			RecordBaseRefFirst("preconf")
		}
	}
}
