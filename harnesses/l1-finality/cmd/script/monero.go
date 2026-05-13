package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Monero: probabilistic finality, "finalized" after N confirmations.
// Public nodes are flaky. cakewallet is the most reliable today, but we
// rotate through a fallback list so a single 502 doesn't blank the chain.

var moneroFallbacks = []string{
	"https://xmr-node.cakewallet.com:18081",
	"https://node.sethforprivacy.com",
	"https://nodex.monerujo.io",
}

type moneroResp[T any] struct {
	Result T             `json:"result"`
	Error  *rpcRespError `json:"error"`
}

type moneroInfo struct {
	Height int64 `json:"height"`
}

type moneroBlockHeader struct {
	BlockHeader struct {
		Height    int64 `json:"height"`
		Timestamp int64 `json:"timestamp"`
	} `json:"block_header"`
}

func fetchMonero(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}

	endpoints := []string{ch.RPCURL}
	for _, fb := range moneroFallbacks {
		if fb != ch.RPCURL {
			endpoints = append(endpoints, fb)
		}
	}

	var lastErr string
	for _, base := range endpoints {
		sample, err := tryMonero(client, base, ch)
		if err == "" {
			sample.FetchLatencyMs = time.Since(start).Milliseconds()
			return sample
		}
		lastErr = err
	}
	s.Err = lastErr
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func tryMonero(client *http.Client, base string, ch ChainConfig) (FinalitySample, string) {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}

	var info moneroResp[moneroInfo]
	if err := moneroCall(client, base, "get_info", nil, &info); err != nil {
		return s, fmt.Sprintf("get_info: %v", err)
	}
	if info.Error != nil {
		return s, fmt.Sprintf("get_info_rpc: %s", info.Error.Message)
	}
	latestHeight := info.Result.Height - 1
	finalHeight := latestHeight - int64(ch.Confirmations)
	if finalHeight < 0 {
		finalHeight = 0
	}

	var latest moneroResp[moneroBlockHeader]
	if err := moneroCall(client, base, "get_block_header_by_height",
		map[string]any{"height": latestHeight}, &latest); err != nil {
		return s, fmt.Sprintf("latest_header: %v", err)
	}
	if latest.Error != nil {
		return s, fmt.Sprintf("latest_header_rpc: %s", latest.Error.Message)
	}

	var final moneroResp[moneroBlockHeader]
	if err := moneroCall(client, base, "get_block_header_by_height",
		map[string]any{"height": finalHeight}, &final); err != nil {
		return s, fmt.Sprintf("final_header: %v", err)
	}
	if final.Error != nil {
		return s, fmt.Sprintf("final_header_rpc: %s", final.Error.Message)
	}

	s.LatestBlock = latestHeight
	s.FinalizedBlock = finalHeight
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = float64(latest.Result.BlockHeader.Timestamp - final.Result.BlockHeader.Timestamp)
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s, ""
}

func moneroCall(client *http.Client, base, method string, params any, out any) error {
	body := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  method,
	}
	if params != nil {
		body["params"] = params
	}
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", strings.TrimRight(base, "/")+"/json_rpc", bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("parse: %v", err)
	}
	return nil
}
