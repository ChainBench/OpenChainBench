package main

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Live feed of every transaction that mentions a terminal's addresses,
// through the RPC's logsSubscribe. Replaces the polling scan of every fee
// wallet: notifications are free on every provider, arrive within a
// second of confirmation, carry the error status, and cover the whole
// population, so the fail rate is exhaustive and the sample is a uniform
// random draw of that population instead of "the newest few".
//
// Per terminal the feed keeps, for the current tick, a count of seen /
// failed signatures and a reservoir of successful ones (uniform sample of
// size reservoirSize); sample() drains it every tick.
type feed struct {
	url  string
	mu   sync.Mutex
	subs map[int64]string // subscription id -> terminal slug
	reqs map[int64]string // request id -> terminal slug (until confirmed)
	box  map[string]*inbox
	up   bool
	last time.Time
}

type inbox struct {
	seen, failed int
	reservoir    []sigInfo
	total        int // successful seen this tick, for reservoir sampling
}

const reservoirSize = 32

func newFeed(rpcURL string) *feed {
	u := rpcURL
	if strings.HasPrefix(u, "https://") {
		u = "wss://" + strings.TrimPrefix(u, "https://")
	} else if strings.HasPrefix(u, "http://") {
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	f := &feed{url: u, subs: map[int64]string{}, reqs: map[int64]string{}, box: map[string]*inbox{}}
	for _, t := range terminals {
		f.box[t.Slug] = &inbox{}
	}
	return f
}

// run keeps one connection alive, resubscribing after every reconnect.
func (f *feed) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := f.session(ctx)
		f.mu.Lock()
		f.up = false
		f.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		log.Printf("[ws] disconnected: %v (retry in %s)", err, backoff)
		time.Sleep(backoff)
		if backoff < 60*time.Second {
			backoff *= 2
		}
	}
}

func (f *feed) session(ctx context.Context) error {
	c, _, err := websocket.Dial(ctx, f.url, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	c.SetReadLimit(4 << 20)
	f.mu.Lock()
	f.subs = map[int64]string{}
	f.reqs = map[int64]string{}
	f.mu.Unlock()
	id := int64(0)
	for _, t := range terminals {
		for _, a := range t.scanAddresses() {
			id++
			f.mu.Lock()
			f.reqs[id] = t.Slug
			f.mu.Unlock()
			msg, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": id, "method": "logsSubscribe",
				"params": []any{map[string]any{"mentions": []string{a}}, map[string]any{"commitment": "confirmed"}},
			})
			if err := c.Write(ctx, websocket.MessageText, msg); err != nil {
				return err
			}
		}
	}
	f.mu.Lock()
	f.up = true
	f.last = time.Now()
	f.mu.Unlock()
	log.Printf("[ws] connected, %d subscriptions requested", id)
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		f.handle(data)
	}
}

func (f *feed) handle(data []byte) {
	var m struct {
		ID     *int64          `json:"id"`
		Result json.RawMessage `json:"result"`
		Method string          `json:"method"`
		Params struct {
			Subscription int64 `json:"subscription"`
			Result       struct {
				Context struct {
					Slot uint64 `json:"slot"`
				} `json:"context"`
				Value struct {
					Signature string          `json:"signature"`
					Err       json.RawMessage `json:"err"`
				} `json:"value"`
			} `json:"result"`
		} `json:"params"`
		Error *rpcError `json:"error"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.last = time.Now()
	if m.ID != nil {
		// Subscription confirmation: result is the subscription id.
		if slug, ok := f.reqs[*m.ID]; ok {
			var sub int64
			if json.Unmarshal(m.Result, &sub) == nil && sub != 0 {
				f.subs[sub] = slug
			} else if m.Error != nil {
				log.Printf("[ws] subscribe %s: %s", slug, m.Error.Message)
			}
			delete(f.reqs, *m.ID)
		}
		return
	}
	if m.Method != "logsNotification" {
		return
	}
	slug, ok := f.subs[m.Params.Subscription]
	if !ok {
		return
	}
	b := f.box[slug]
	if b == nil {
		return
	}
	s := sigInfo{Signature: m.Params.Result.Value.Signature, Slot: m.Params.Result.Context.Slot, Err: m.Params.Result.Value.Err}
	now := time.Now().Unix()
	s.BlockTime = &now
	b.seen++
	if s.failed() {
		b.failed++
		return
	}
	// Reservoir sampling: every successful signature of the tick has the
	// same chance to be in the sample.
	b.total++
	if len(b.reservoir) < reservoirSize {
		b.reservoir = append(b.reservoir, s)
	} else if j := rand.Intn(b.total); j < reservoirSize {
		b.reservoir[j] = s
	}
}

// drain returns and resets a terminal's inbox.
func (f *feed) drain(slug string) (seen, failed int, sample []sigInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := f.box[slug]
	if b == nil {
		return 0, 0, nil
	}
	seen, failed, sample = b.seen, b.failed, b.reservoir
	f.box[slug] = &inbox{}
	return
}

// healthy: connected and something heard in the last two minutes.
func (f *feed) healthy() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.up && time.Since(f.last) < 2*time.Minute
}
