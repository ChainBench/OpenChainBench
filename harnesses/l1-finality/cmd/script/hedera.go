package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Hedera Mirror Node /api/v1/blocks. Hedera's hashgraph reaches consensus
// in 2-3 s; once a record is in a closed block it's final. Approximate
// the lag with the wall-clock distance between the latest block and one
// block back.

type hederaBlocks struct {
	Blocks []struct {
		Number    int64  `json:"number"`
		Timestamp struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"timestamp"`
	} `json:"blocks"`
}

func fetchHedera(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	url := ch.RPCURL + "/api/v1/blocks?order=desc&limit=2"
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		s.Err = fmt.Sprintf("request: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	if resp.StatusCode != 200 {
		s.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		return s
	}

	var parsed hederaBlocks
	if err := json.Unmarshal(body, &parsed); err != nil {
		s.Err = fmt.Sprintf("parse: %v", err)
		return s
	}
	if len(parsed.Blocks) < 2 {
		s.Err = fmt.Sprintf("too_few_blocks: %d", len(parsed.Blocks))
		return s
	}

	latest := parsed.Blocks[0]
	final := parsed.Blocks[1]

	// Hedera timestamps are "<sec>.<nanos>", e.g. "1778098955.982582409".
	// Parse the full string as float so we keep nanosecond precision.
	parseTs := strconv.ParseFloat
	latestTs, err := parseTs(latest.Timestamp.To, 64)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_ts: %v", err)
		return s
	}
	finalTs, err := parseTs(final.Timestamp.To, 64)
	if err != nil {
		s.Err = fmt.Sprintf("parse_final_ts: %v", err)
		return s
	}

	s.LatestBlock = latest.Number
	s.FinalizedBlock = final.Number
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = latestTs - finalTs
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}
