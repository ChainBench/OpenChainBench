package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Algorand round time, on our clock.
//
// Algorand has no unfinalized head: a block exists for a node only once its
// round is certified, so "first seen" and "final" are the same moment. The
// block header's `ts` is whole seconds, too coarse for a ~3 s figure, so
// the Avalanche method (production timestamp -> arrival) is not usable.
// What is measurable is the round: the proposal for round r+1 is made once
// round r is certified, then soft-voted and cert-voted. The wall-clock gap
// between two consecutive certified rounds is therefore one proposal ->
// certification cycle, the time a block takes to become final once
// proposed. Same family as the Stellar (ledger close) and SUI (checkpoint)
// rows.
//
// algod's /v2/status/wait-for-block-after/{round} is a long poll that
// returns as soon as the node has a round above it, so arrivals are timed
// without poll aliasing. Only consecutive rounds are timed: a gap (a missed
// long poll, a restart) would mix two rounds into one sample.

const algorandDefaultURL = "https://mainnet-api.algonode.cloud"

type algorandState struct {
	lastRound int64
	lastAt    time.Time
}

// advance returns the round interval (ms) when round follows the previous
// one directly; anything else only re-anchors.
func (st *algorandState) advance(round int64, now time.Time) (float64, bool) {
	prevRound, prevAt := st.lastRound, st.lastAt
	if round <= prevRound {
		return 0, false
	}
	st.lastRound, st.lastAt = round, now
	if prevRound == 0 || round != prevRound+1 {
		return 0, false
	}
	ms := float64(now.Sub(prevAt).Milliseconds())
	if ms <= 0 || ms > 60000 {
		return 0, false
	}
	return ms, true
}

func StartAlgorandWallClock() {
	url := getenvDefault("RPC_ALGORAND", algorandDefaultURL)
	go func() {
		backoff := 2 * time.Second
		for {
			err := runAlgorandWait(url)
			if err != nil {
				fmt.Printf("[L1][algorand] error: %v (retrying in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("algorand").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runAlgorandWait(url string) error {
	client := &http.Client{Timeout: 20 * time.Second}
	round, err := algorandGet(client, url+"/v2/status")
	if err != nil {
		return fmt.Errorf("status: %w", err)
	}
	wallClockHealth.WithLabelValues("algorand").Set(1)
	st := &algorandState{}
	consecErrors := 0
	for {
		next, err := algorandGet(client, fmt.Sprintf("%s/v2/status/wait-for-block-after/%d", url, round))
		now := time.Now()
		if err != nil {
			consecErrors++
			st.lastRound = 0 // do not time across the hole
			if consecErrors >= 10 {
				return fmt.Errorf("too many errors: %w", err)
			}
			time.Sleep(time.Second)
			continue
		}
		consecErrors = 0
		if ms, ok := st.advance(next, now); ok {
			recordWallClock("algorand", ms)
			if next%20 == 0 {
				fmt.Printf("[L1][algorand] round=%d interval=%.0fms\n", next, ms)
			}
		}
		if next > round {
			round = next
		}
	}
}

func algorandGet(client *http.Client, url string) (int64, error) {
	resp, err := client.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status_%d", resp.StatusCode)
	}
	return parseAlgorandStatus(body)
}

func parseAlgorandStatus(body []byte) (int64, error) {
	var s struct {
		LastRound int64 `json:"last-round"`
	}
	if err := json.Unmarshal(body, &s); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if s.LastRound <= 0 {
		return 0, fmt.Errorf("parse: no last-round")
	}
	return s.LastRound, nil
}
