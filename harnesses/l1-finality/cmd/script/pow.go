package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// PoW chains: probabilistic finality, "finalized" === N confirmations back.
//
// We use an Esplora-compatible block explorer (litecoinspace.org for Litecoin;
// mempool.space-style API works the same way for Bitcoin if added later).
// `GET /api/blocks` returns the last ~15 blocks with `height` and `timestamp`,
// so a single call covers BOTH the latest block AND the finalized one (12
// confirmations back for Litecoin). This replaces the old 2-call blockchair
// flow that was blacklisted by free-tier IP rate limits.
//
// API spec: https://github.com/Blockstream/esplora/blob/master/API.md

type esploraBlock struct {
	ID        string `json:"id"`        // block hash
	Height    int64  `json:"height"`
	Timestamp int64  `json:"timestamp"` // unix seconds, UTC
}

func fetchBitcoinLike(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}

	blocks, err := esploraRecentBlocks(client, ch.RPCURL)
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		s.Err = fmt.Sprintf("blocks: %v", err)
		return s
	}
	if len(blocks) == 0 {
		s.Err = "blocks: empty"
		return s
	}

	tip := blocks[0]
	// If the returned window is shorter than the desired confirmations
	// depth, paginate one more call using /api/blocks/<height>. Litecoin
	// (12 conf) is satisfied by the default 15-block window.
	finalIdx := ch.Confirmations
	if finalIdx >= len(blocks) {
		more, err := esploraBlocksFrom(client, ch.RPCURL, tip.Height-int64(ch.Confirmations))
		if err != nil {
			s.Err = fmt.Sprintf("blocks_at_h-%d: %v", ch.Confirmations, err)
			return s
		}
		if len(more) == 0 {
			s.Err = "blocks_at_h: empty"
			return s
		}
		// /api/blocks/<H> returns blocks <= H, newest first; index 0 is the
		// finalized block we want.
		final := more[0]
		s.LatestBlock = tip.Height
		s.FinalizedBlock = final.Height
		s.BlockLag = s.LatestBlock - s.FinalizedBlock
		s.LagSeconds = float64(tip.Timestamp - final.Timestamp)
		if s.LagSeconds < 0 {
			s.LagSeconds = 0
		}
		return s
	}

	final := blocks[finalIdx]
	s.LatestBlock = tip.Height
	s.FinalizedBlock = final.Height
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = float64(tip.Timestamp - final.Timestamp)
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

// esploraRecentBlocks calls GET /api/blocks — returns the most recent ~15
// blocks, newest first. Each entry has height + unix timestamp.
func esploraRecentBlocks(client *http.Client, base string) ([]esploraBlock, error) {
	return esploraGetBlocks(client, base+"/blocks")
}

// esploraBlocksFrom calls GET /api/blocks/<height> — returns blocks <= height,
// newest first. Used when the desired confirmations depth exceeds the default
// 15-block window.
func esploraBlocksFrom(client *http.Client, base string, height int64) ([]esploraBlock, error) {
	return esploraGetBlocks(client, fmt.Sprintf("%s/blocks/%d", base, height))
}

func esploraGetBlocks(client *http.Client, url string) ([]esploraBlock, error) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var blocks []esploraBlock
	if err := json.Unmarshal(body, &blocks); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	return blocks, nil
}
