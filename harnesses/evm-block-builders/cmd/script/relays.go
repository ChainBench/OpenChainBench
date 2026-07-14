package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// MEV-Boost relay bidtrace pollers.
//
// Every major relay exposes the standard Relay Data API keyless:
//   GET /relay/v1/data/bidtraces/proposer_payload_delivered?limit=N
// One entry per delivered payload (= one relayed block). We poll each
// relay every 5 min and count NEW slots per relay via a high-water-mark
// so restarts / overlapping windows never double-count within a relay.
//
// The same slot appearing on multiple relays is NORMAL (builders
// multi-home their bids; the winning payload is reported by every relay
// that carried it), so relay counters are a market-share signal for
// relays, not a partition of blocks. This is the independent
// cross-check on the extraData attribution: relay-side builder pubkeys
// don't depend on the builder's self-chosen extraData tag.

type relayEndpoint struct {
	Slug string
	Base string
}

// relays verified answering keyless at bench inception (2026-07-14).
func relays() []relayEndpoint {
	return []relayEndpoint{
		{"flashbots", "https://boost-relay.flashbots.net"},
		{"ultrasound", "https://relay.ultrasound.money"},
		{"agnostic", "https://agnostic-relay.net"},
		{"bloxroute-max-profit", "https://bloxroute.max-profit.blxrbdn.com"},
		{"bloxroute-regulated", "https://bloxroute.regulated.blxrbdn.com"},
		{"titan", "https://titanrelay.xyz"},
		{"aestus", "https://aestus.live"},
	}
}

type bidTrace struct {
	Slot string `json:"slot"`
}

// runRelayPolls launches one poller goroutine per relay.
func runRelayPolls(ctx context.Context) {
	for _, r := range relays() {
		r := r
		go pollRelay(ctx, r)
	}
}

func pollRelay(ctx context.Context, r relayEndpoint) {
	url := r.Base + "/relay/v1/data/bidtraces/proposer_payload_delivered?limit=50"
	fmt.Printf("[relay:%s] polling %s every %s\n", r.Slug, url, relayPollInterval)

	var maxSeenSlot int64
	t := time.NewTicker(relayPollInterval)
	defer t.Stop()
	for {
		slots, err := fetchDeliveredSlots(url)
		if err != nil {
			relayPollErrors.WithLabelValues(r.Slug).Inc()
			relayHealth.WithLabelValues(r.Slug).Set(0)
			fmt.Printf("[relay:%s] poll error: %v\n", r.Slug, err)
		} else {
			relayHealth.WithLabelValues(r.Slug).Set(1)
			fresh := 0
			for _, s := range slots {
				if s > maxSeenSlot {
					fresh++
				}
			}
			if len(slots) > 0 {
				sort.Slice(slots, func(i, j int) bool { return slots[i] > slots[j] })
				if slots[0] > maxSeenSlot {
					maxSeenSlot = slots[0]
				}
			}
			relayPayloadsTotal.WithLabelValues(r.Slug).Add(float64(fresh))
			relayLastSlot.WithLabelValues(r.Slug).Set(float64(maxSeenSlot))
			fmt.Printf("[relay:%s] delivered=%d fresh=%d maxSlot=%d\n", r.Slug, len(slots), fresh, maxSeenSlot)
		}

		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// fetchDeliveredSlots GETs the bidtraces endpoint and returns the slot
// numbers, deduped within the response (defensive: the same slot can
// appear twice on a relay after a reorged proposal).
func fetchDeliveredSlots(url string) ([]int64, error) {
	req, err := newRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	var traces []bidTrace
	if err := json.NewDecoder(resp.Body).Decode(&traces); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	seen := make(map[int64]struct{}, len(traces))
	out := make([]int64, 0, len(traces))
	for _, tr := range traces {
		n, err := strconv.ParseInt(tr.Slot, 10, 64)
		if err != nil || n == 0 {
			continue
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	return out, nil
}
