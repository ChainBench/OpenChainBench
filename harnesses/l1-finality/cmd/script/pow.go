package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// PoW chains: probabilistic finality, "finalized" === N confirmations
// back. We use blockchair's free public API for the Bitcoin-family
// (Litecoin works the same way; Bitcoin would too if added).

type blockchairStats struct {
	Data struct {
		Blocks       int64 `json:"blocks"`
		BestBlockTime string `json:"best_block_time"` // "2026-05-06 19:01:13" UTC
	} `json:"data"`
}

type blockchairBlock struct {
	Data map[string]struct {
		Block struct {
			ID    int64  `json:"id"`
			Time  string `json:"time"` // UTC string
		} `json:"block"`
	} `json:"data"`
}

func fetchBitcoinLike(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}

	stats, err := blockchairStatsFetch(client, ch.RPCURL)
	if err != nil {
		s.Err = fmt.Sprintf("stats: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	latestHeight := stats.Data.Blocks - 1 // blocks count is 1-indexed
	finalHeight := latestHeight - int64(ch.Confirmations)
	if finalHeight < 0 {
		finalHeight = 0
	}

	finalBlock, err := blockchairBlockAt(client, ch.RPCURL, finalHeight)
	if err != nil {
		s.Err = fmt.Sprintf("final_block (h=%d): %v", finalHeight, err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	latestTs, err := time.Parse("2006-01-02 15:04:05", stats.Data.BestBlockTime)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_ts: %v", err)
		return s
	}
	finalTs, err := time.Parse("2006-01-02 15:04:05", finalBlock.Time)
	if err != nil {
		s.Err = fmt.Sprintf("parse_final_ts: %v", err)
		return s
	}

	s.LatestBlock = latestHeight
	s.FinalizedBlock = finalHeight
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = latestTs.Sub(finalTs).Seconds()
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func blockchairStatsFetch(client *http.Client, base string) (*blockchairStats, error) {
	resp, err := client.Get(base + "/stats")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var parsed blockchairStats
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	return &parsed, nil
}

type blockchairSimpleBlock struct {
	ID   int64  `json:"id"`
	Time string `json:"time"`
}

func blockchairBlockAt(client *http.Client, base string, height int64) (*blockchairSimpleBlock, error) {
	resp, err := client.Get(base + "/dashboards/block/" + strconv.FormatInt(height, 10))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var parsed blockchairBlock
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	for _, v := range parsed.Data {
		return &blockchairSimpleBlock{ID: v.Block.ID, Time: v.Block.Time}, nil
	}
	return nil, fmt.Errorf("no_block_in_response: %s", truncate(string(body), 200))
}
