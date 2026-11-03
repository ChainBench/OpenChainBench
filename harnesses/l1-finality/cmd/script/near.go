package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// NEAR BFT finality, timed on the chain's own nanosecond timestamps.
//
// NEAR separates the head (`optimistic`) from BFT finality (`final`): every
// header names `last_final_block`, the newest block with a finality
// certificate, normally two blocks behind it, and RPC `final` returns exactly
// that block. Block F becomes final when the first block naming it is
// produced, so the time F took to become final is
//
//	timestamp(first block naming F) - timestamp(F)
//
// with both timestamps in nanoseconds, set by the producers. This is the
// Ethereum row's latest.timestamp - finalized.timestamp, with a resolution
// fine enough for a ~1 s figure.
//
// The head H we poll is the first block naming F only when its parent named
// an older final block, so each poll also fetches H's parent and F by hash
// (unless already cached): three requests every 2 s. Because both ends are
// chain timestamps, the poll cadence sets how many samples we take, not
// their value. Both FastNEAR hosts (rpc.mainnet and free.rpc) answered 429
// within minutes at 1.5 to 5 requests a second on 2026-11-03; dRPC's free
// NEAR endpoint served 90 of 90 at 1.5 a second and is the default.

const (
	nearDefaultURL   = "https://near.drpc.org"
	nearPollInterval = 2 * time.Second
)

type nearHeader struct {
	Height         int64  `json:"height"`
	Hash           string `json:"hash"`
	PrevHash       string `json:"prev_hash"`
	LastFinalBlock string `json:"last_final_block"`
	TimestampNs    string `json:"timestamp_nanosec"`
	ts             int64
}

type nearState struct {
	seen    map[string]nearHeader
	lastF   string // final block of the last emitted sample
	maxSeen int64
}

func newNearState() *nearState {
	return &nearState{seen: map[string]nearHeader{}}
}

// remember caches a block fetched by hash (a parent or a final block) so a
// later head can be timed against it. It never emits.
func (st *nearState) remember(h nearHeader) {
	if h.Height > 0 && h.Hash != "" && h.ts > 0 {
		if _, ok := st.seen[h.Hash]; !ok {
			st.seen[h.Hash] = h
		}
	}
}

// observe takes one optimistic head and returns the finality lag (ms) of
// the block it made final, when it can be timed.
func (st *nearState) observe(h nearHeader) (float64, bool) {
	if h.Height <= 0 || h.Hash == "" || h.ts <= 0 {
		return 0, false
	}
	if _, dup := st.seen[h.Hash]; dup {
		return 0, false
	}
	st.seen[h.Hash] = h
	if h.Height > st.maxSeen {
		st.maxSeen = h.Height
	}
	for k, v := range st.seen {
		if v.Height < st.maxSeen-200 {
			delete(st.seen, k)
		}
	}
	parent, okP := st.seen[h.PrevHash]
	fin, okF := st.seen[h.LastFinalBlock]
	if !okP || !okF || parent.LastFinalBlock == h.LastFinalBlock || h.LastFinalBlock == st.lastF {
		return 0, false
	}
	lag := float64(h.ts-fin.ts) / 1e6
	if lag <= 0 || lag > 60000 {
		return 0, false
	}
	st.lastF = h.LastFinalBlock
	return lag, true
}

func StartNearWallClock() {
	url := getenvDefault("RPC_NEAR", nearDefaultURL)
	go func() {
		backoff := 2 * time.Second
		for {
			err := runNearPoll(url)
			if err != nil {
				fmt.Printf("[L1][near] poll error: %v (retrying in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("near").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runNearPoll(url string) error {
	client := &http.Client{Timeout: 4 * time.Second}
	tick := time.NewTicker(nearPollInterval)
	defer tick.Stop()
	st := newNearState()
	consecErrors := 0
	healthy := false
	n := 0
	for range tick.C {
		h, err := nearBlock(client, url, `{"finality":"optimistic"}`)
		if err == nil {
			for _, hash := range []string{h.PrevHash, h.LastFinalBlock} {
				if _, ok := st.seen[hash]; ok {
					continue
				}
				b, berr := nearBlock(client, url, `{"block_id":"`+hash+`"}`)
				if berr != nil {
					err = berr
					break
				}
				st.remember(b)
			}
		}
		if err != nil {
			consecErrors++
			if consecErrors >= 10 {
				return fmt.Errorf("too many errors: %w", err)
			}
			continue
		}
		consecErrors = 0
		if !healthy {
			wallClockHealth.WithLabelValues("near").Set(1)
			healthy = true
		}
		if ms, ok := st.observe(h); ok {
			recordWallClock("near", ms)
			if n++; n%30 == 0 {
				fmt.Printf("[L1][near] head=%d final-lag=%.0fms\n", h.Height, ms)
			}
		}
	}
	return nil
}

// nearBlock calls `block` with raw params: {"finality":"optimistic"} or
// {"block_id":"<hash>"}. Hashes are base58, safe to splice into JSON.
func nearBlock(client *http.Client, url, params string) (nearHeader, error) {
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"block","params":` + params + `}`)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nearHeader{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return nearHeader{}, fmt.Errorf("status_%d", resp.StatusCode)
	}
	return parseNearBlock(raw)
}

func parseNearBlock(raw []byte) (nearHeader, error) {
	var r struct {
		Result *struct {
			Header nearHeader `json:"header"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nearHeader{}, fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return nearHeader{}, fmt.Errorf("rpc: %s", r.Error.Message)
	}
	if r.Result == nil {
		return nearHeader{}, fmt.Errorf("parse: no header")
	}
	h := r.Result.Header
	ts, err := strconv.ParseInt(h.TimestampNs, 10, 64)
	if err != nil || h.Height <= 0 || h.Hash == "" || h.PrevHash == "" || h.LastFinalBlock == "" {
		return nearHeader{}, fmt.Errorf("parse: incomplete header")
	}
	h.ts = ts
	return h, nil
}
