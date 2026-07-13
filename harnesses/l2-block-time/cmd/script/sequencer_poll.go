package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// HTTP polling fallback for sequencers with no public WebSocket
// (Robinhood Chain). Every pollInterval we read eth_blockNumber; a
// window that advanced by N blocks contributes N histogram samples of
// (elapsed / N) ms. This yields an accurate average block time while
// keeping the "one sample per block" weighting of the WS path; what it
// cannot capture is per-block jitter, which the bench methodology
// discloses for polled chains.
const (
	pollInterval   = 2 * time.Second
	pollTimeout    = 10 * time.Second
	maxWindowBlend = 600 // safety cap on samples per window (reconnect gaps)
)

func runPollChain(ch L2Chain) error {
	client := &http.Client{Timeout: pollTimeout}
	var lastNum int64
	var lastAt time.Time
	fails := 0

	t := time.NewTicker(pollInterval)
	defer t.Stop()
	fmt.Printf("[%s] HTTP polling mode, interval=%s\n", ch.Slug, pollInterval)

	for now := range t.C {
		num, err := fetchBlockNumber(client, ch.URL)
		if err != nil || num == 0 {
			fails++
			if fails >= 5 {
				blockTimeHealth.WithLabelValues(ch.Slug).Set(0)
			}
			if fails == 5 || fails%150 == 0 {
				fmt.Printf("[%s] poll error x%d: %v\n", ch.Slug, fails, err)
			}
			continue
		}
		fails = 0
		blockTimeHealth.WithLabelValues(ch.Slug).Set(1)

		if lastNum > 0 && num > lastNum && !lastAt.IsZero() {
			delta := num - lastNum
			elapsedMs := float64(now.Sub(lastAt).Milliseconds())
			perBlock := elapsedMs / float64(delta)
			if perBlock > 0 && perBlock < maxSampleMs {
				blockTimeGauge.WithLabelValues(ch.Slug).Set(perBlock)
				n := int(delta)
				if n > maxWindowBlend {
					n = maxWindowBlend
				}
				for i := 0; i < n; i++ {
					blockTimeHistogram.WithLabelValues(ch.Slug).Observe(perBlock)
				}
				blockTimeSampleCtr.WithLabelValues(ch.Slug).Add(float64(n))
			}
		}
		lastNum = num
		lastAt = now
	}
	return nil
}

func fetchBlockNumber(client *http.Client, url string) (int64, error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":%d}`,
		time.Now().UnixNano(),
	))
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return 0, err
	}
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	var env struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return 0, err
	}
	n := parseHexInt64(env.Result)
	if n == 0 {
		return 0, fmt.Errorf("empty block number")
	}
	return n, nil
}
