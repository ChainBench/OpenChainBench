package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Cardano: Koios free public API. Probabilistic finality. We measure
// the gap at the practical-settlement convention used by major
// exchanges (Coinbase = 10 confs, Kraken = 15) — the depth defined in
// config.go (currently 15). Theoretical Ouroboros Praos full settlement
// is k = 2160 blocks (~12 h) but no production actor waits that long.

// Koios: /tip is fast, /blocks?block_height=eq.X also fast.
// /blocks with order+limit is broken under load. Use /tip + a specific
// block-height query for the finalized block.

type koiosTipRecord struct {
	BlockHeight int64 `json:"block_height"`
	BlockTime   int64 `json:"block_time"`
}

func fetchCardano(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	tip, err := koiosGet[[]koiosTipRecord](client, ch.RPCURL+"/tip?select=block_height,block_time")
	if err != nil {
		s.Err = fmt.Sprintf("tip: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(*tip) == 0 {
		s.Err = "empty_tip"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	latest := (*tip)[0]
	finalHeight := latest.BlockHeight - int64(ch.Confirmations)
	if finalHeight < 0 {
		finalHeight = 0
	}

	q := url.Values{}
	q.Set("block_height", "eq."+strconv.FormatInt(finalHeight, 10))
	q.Set("select", "block_height,block_time")
	finalRows, err := koiosGet[[]koiosTipRecord](client, ch.RPCURL+"/blocks?"+q.Encode())
	if err != nil {
		s.Err = fmt.Sprintf("final_block: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	if len(*finalRows) == 0 {
		s.Err = fmt.Sprintf("no_block_at_height_%d", finalHeight)
		return s
	}
	final := (*finalRows)[0]

	s.LatestBlock = latest.BlockHeight
	s.FinalizedBlock = final.BlockHeight
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = float64(latest.BlockTime - final.BlockTime)
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func koiosGet[T any](client *http.Client, url string) (*T, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var parsed T
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	return &parsed, nil
}
