package main

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Live feed of every transaction that mentions a terminal's addresses,
// through the RPC's logsSubscribe. Replaces the polling scan of every fee
// wallet: notifications are free on every provider, arrive within a
// second of confirmation, carry the error status and the program logs,
// and cover the whole population, so the fail rate is exhaustive and the
// sample is a uniform random draw of that population instead of "the
// newest few".
//
// Each notification is classified from its logs: a swap attempt invokes a
// venue, the aggregator or the terminal's router (swapProgramPrefixes);
// anything else (wallet funding, fee sweeps, GMGN's 1-lamport markers) is
// counted apart and never enters the fail rate. Per terminal the feed
// keeps, for the current tick, the attempts seen / failed (with the error
// class) and a reservoir of successful ones (uniform sample of size
// reservoirSize); sample() drains it every tick.
type feed struct {
	url  string
	mu   sync.Mutex
	subs map[int64]string // subscription id -> terminal slug
	reqs map[int64]string // request id -> terminal slug (until confirmed)
	box  map[string]*inbox
	ok   map[string]int // successful attempts of the last drained tick
	up   bool
	last time.Time
}

type inbox struct {
	seen, failed, other int
	errs                map[string]int
	reservoir           []sigInfo
	total               int             // successful attempts this tick, for reservoir sampling
	failedSample        []sigInfo       // uniform sample of the failed attempts (their cost is read from a few of them)
	sigs                map[string]bool // signatures already counted this tick (a tx can mention two subscribed addresses)
}

// drained is one terminal's inbox at the end of a tick.
type drained struct {
	seen, failed, other int
	errs                map[string]int
	sample              []sigInfo
	failedSample        []sigInfo
	total               int
}

const (
	reservoirSize     = 32
	failReservoirSize = 8
)

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
// The backoff grows on repeated failures and resets once a session has
// held for a minute.
func (f *feed) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := f.session(ctx)
		f.mu.Lock()
		f.up = false
		f.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
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
		// A live cohort produces hundreds of notifications a minute; two
		// silent minutes mean a dead connection, so reconnect.
		rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		_, data, err := c.Read(rctx)
		cancel()
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
					Logs      []string        `json:"logs"`
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
	if b.sigs == nil {
		b.sigs = map[string]bool{}
	}
	v := m.Params.Result.Value
	if b.sigs[v.Signature] {
		return
	}
	b.sigs[v.Signature] = true
	if !isSwapAttempt(v.Logs) {
		b.other++
		return
	}
	s := sigInfo{Signature: v.Signature, Slot: m.Params.Result.Context.Slot, Err: v.Err}
	now := time.Now().Unix()
	s.BlockTime = &now
	b.seen++
	if s.failed() {
		b.failed++
		if b.errs == nil {
			b.errs = map[string]int{}
		}
		b.errs[errClass(v.Err)]++
		if len(b.failedSample) < failReservoirSize {
			b.failedSample = append(b.failedSample, s)
		} else if j := rand.Intn(b.failed); j < failReservoirSize {
			b.failedSample[j] = s
		}
		return
	}
	// Reservoir sampling: every successful attempt of the tick has the
	// same chance to be in the sample.
	b.total++
	if len(b.reservoir) < reservoirSize {
		b.reservoir = append(b.reservoir, s)
	} else if j := rand.Intn(b.total); j < reservoirSize {
		b.reservoir[j] = s
	}
}

// isSwapAttempt: the logs show a swap program being invoked (top-level
// or CPI). A failed swap logs its invocations up to the failing
// instruction, and the swap program is what fails, so it is there.
func isSwapAttempt(logs []string) bool {
	for _, l := range logs {
		if !strings.HasPrefix(l, "Program ") {
			continue
		}
		rest := l[len("Program "):]
		sp := strings.IndexByte(rest, ' ')
		if sp <= 0 || !strings.HasPrefix(rest[sp:], " invoke [") {
			continue
		}
		id := rest[:sp]
		for _, p := range swapProgramPrefixes {
			if strings.HasPrefix(id, p) {
				return true
			}
		}
	}
	return false
}

// errClass reduces a transaction error to a short label: the program's
// custom code ("custom:6001", pump.fun's slippage error) or the runtime
// error name ("InsufficientFunds", "SlippageToleranceExceeded"…).
func errClass(raw json.RawMessage) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) == nil {
		if ie, ok := m["InstructionError"]; ok {
			var arr []json.RawMessage
			if json.Unmarshal(ie, &arr) == nil && len(arr) == 2 {
				var s string
				if json.Unmarshal(arr[1], &s) == nil {
					return s
				}
				var c map[string]int
				if json.Unmarshal(arr[1], &c) == nil {
					for k, v := range c {
						return k + ":" + strconv.Itoa(v)
					}
				}
			}
			return "InstructionError"
		}
		for k := range m {
			return k
		}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return "unknown"
}

// drain returns and resets a terminal's inbox; the successful count of
// the drained tick stays readable through lastOK.
func (f *feed) drain(slug string) drained {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := f.box[slug]
	if b == nil {
		return drained{}
	}
	d := drained{seen: b.seen, failed: b.failed, other: b.other, errs: b.errs, sample: b.reservoir, failedSample: b.failedSample, total: b.total}
	f.box[slug] = &inbox{}
	if f.ok == nil {
		f.ok = map[string]int{}
	}
	f.ok[slug] = b.total
	return d
}

// lastOK: successful attempts of the last drained tick for a terminal.
func (f *feed) lastOK(slug string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ok[slug]
}

// healthy: connected and something heard in the last two minutes.
func (f *feed) healthy() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.up && time.Since(f.last) < 2*time.Minute
}
