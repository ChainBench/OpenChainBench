package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// TRON: REST endpoints rather than JSON-RPC.
//   - POST /wallet/getnowblock        → latest block (full)
//   - POST /walletsolidity/getnowblock → latest *solidity-confirmed* block
//     (TRON's analogue of finalized — committed by SR consensus)

type tronBlock struct {
	BlockHeader struct {
		RawData struct {
			Number    int64 `json:"number"`
			Timestamp int64 `json:"timestamp"` // ms
		} `json:"raw_data"`
	} `json:"block_header"`
}

func fetchTron(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()

	client := &http.Client{Timeout: 8 * time.Second}

	latest, err := tronGetBlock(client, ch.RPCURL+"/wallet/getnowblock")
	if err != nil {
		s.Err = fmt.Sprintf("latest: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	final, err := tronGetBlock(client, ch.RPCURL+"/walletsolidity/getnowblock")
	if err != nil {
		s.Err = fmt.Sprintf("finalized: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	s.LatestBlock = latest.BlockHeader.RawData.Number
	s.FinalizedBlock = final.BlockHeader.RawData.Number
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = float64(latest.BlockHeader.RawData.Timestamp-final.BlockHeader.RawData.Timestamp) / 1000.0
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func tronGetBlock(client *http.Client, url string) (*tronBlock, error) {
	req, _ := http.NewRequest("POST", url, strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var parsed tronBlock
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	if parsed.BlockHeader.RawData.Number == 0 {
		return nil, fmt.Errorf("empty_block_header body=%s", truncate(string(body), 200))
	}
	return &parsed, nil
}
