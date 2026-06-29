package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

// TON: tonapi.io anonymous tier supports masterchain-head + blocks/{id}
// reads. Toncenter free has 1 rps which we burst past with two block
// fetches per cycle; tonapi is friendlier. Switching there.

const tonAPIBase = "https://tonapi.io/v2"

type tonapiBlock struct {
	WorkchainID int    `json:"workchain_id"`
	Shard       string `json:"shard"`
	Seqno       int64  `json:"seqno"`
	GenUtime    int64  `json:"gen_utime"`
}

func fetchTon(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}

	// Use the configured base if it points at tonapi-style; otherwise
	// default to tonapi.io which works anonymously.
	base := ch.RPCURL
	if base == "" || base == "https://toncenter.com/api/v2" {
		base = tonAPIBase
	}

	latest, err := tonapiHead(client, base)
	if err != nil {
		s.Err = fmt.Sprintf("head: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	finalSeqno := latest.Seqno - 3
	final, err := tonapiBlockByID(client, base, latest.WorkchainID, latest.Shard, finalSeqno)
	if err != nil {
		s.Err = fmt.Sprintf("final_block: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	s.LatestBlock = latest.Seqno
	s.FinalizedBlock = final.Seqno
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = float64(latest.GenUtime - final.GenUtime)
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func tonapiHead(client *http.Client, base string) (*tonapiBlock, error) {
	return tonapiGet(client, base+"/blockchain/masterchain-head")
}

func tonapiBlockByID(client *http.Client, base string, wc int, shard string, seqno int64) (*tonapiBlock, error) {
	// tonapi.io expects the (workchain,shard,seqno) tuple in parentheses,
	// not the colon-separated TON-native form.
	id := fmt.Sprintf("(%d,%s,%d)", wc, shard, seqno)
	return tonapiGet(client, base+"/blockchain/blocks/"+id)
}

func tonapiGet(client *http.Client, url string) (*tonapiBlock, error) {
	req, _ := http.NewRequest("GET", url, nil)
	if k := os.Getenv("TON_API_KEY"); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var parsed tonapiBlock
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	if parsed.Seqno == 0 && parsed.GenUtime == 0 {
		return nil, fmt.Errorf("empty: %s", truncate(string(body), 200))
	}
	return &parsed, nil
}

// Quiet the linter — strconv was used in earlier toncenter version.
var _ = strconv.Itoa
