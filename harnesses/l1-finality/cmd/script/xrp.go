package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// XRPL: ledger_current (open, not validated) + ledger_validated (validated).
// In XRPL terms, "validated" === finalized.

// XRPL JSON sometimes types fields differently across responses (top-level
// ledger_index is int, ledger.ledger_index is string). We only consume the
// top-level int and the inner close_time, so we leave the inner index out.
type xrpLedger struct {
	CloseTime int64 `json:"close_time"` // seconds since 2000-01-01 (Ripple epoch)
}

type xrpResp struct {
	Result struct {
		LedgerIndex        int       `json:"ledger_index"`
		LedgerCurrentIndex int       `json:"ledger_current_index"`
		Ledger             xrpLedger `json:"ledger"`
		Status             string    `json:"status"`
		Validated          bool      `json:"validated"`
	} `json:"result"`
}

const rippleEpochOffset = 946684800 // seconds from Unix epoch to 2000-01-01

func fetchXRP(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	// Validated = finalized in XRPL.
	val, err := xrpRequest(client, ch.RPCURL, "ledger", map[string]any{
		"ledger_index": "validated",
		"transactions": false,
	})
	if err != nil {
		s.Err = fmt.Sprintf("validated: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	cur, err := xrpRequest(client, ch.RPCURL, "ledger_current", map[string]any{})
	if err != nil {
		s.Err = fmt.Sprintf("current: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	s.LatestBlock = int64(cur.Result.LedgerCurrentIndex)
	s.FinalizedBlock = int64(val.Result.LedgerIndex)
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	// XRPL doesn't expose close_time on ledger_current. Approximate the
	// lag from the block count × 4s avg ledger interval (matches XRPL's
	// 3-5 s validation cycle).
	s.LagSeconds = float64(s.BlockLag) * 4.0
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	_ = rippleToUnix // keep helper around for future use
	return s
}

func xrpRequest(client *http.Client, url, method string, params map[string]any) (*xrpResp, error) {
	body := map[string]any{
		"method": method,
		"params": []map[string]any{params},
	}
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	var parsed xrpResp
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v", err)
	}
	if parsed.Result.Status == "error" {
		return nil, fmt.Errorf("xrpl_error: %s", truncate(string(respBody), 200))
	}
	return &parsed, nil
}

// Convert Ripple epoch (seconds since 2000-01-01) to Unix seconds.
func rippleToUnix(t int64) int64 { return t + rippleEpochOffset }
