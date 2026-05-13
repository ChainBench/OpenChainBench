package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Stellar: Horizon /ledgers — every closed ledger is final by SCP. We
// measure the wall-clock distance between the latest ledger and a few
// ledgers back, treating "5 ledgers back" as "deeply confirmed".

type stellarLedgerResp struct {
	Embedded struct {
		Records []struct {
			Sequence int    `json:"sequence"`
			ClosedAt string `json:"closed_at"` // RFC3339
		} `json:"records"`
	} `json:"_embedded"`
}

func fetchStellar(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	url := ch.RPCURL + "/ledgers?order=desc&limit=10"
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

	var parsed stellarLedgerResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		s.Err = fmt.Sprintf("parse: %v", err)
		return s
	}
	if len(parsed.Embedded.Records) < 2 {
		s.Err = fmt.Sprintf("too_few_ledgers: %d", len(parsed.Embedded.Records))
		return s
	}

	latest := parsed.Embedded.Records[0]
	// "Finalized": one ledger back is already confirmed in SCP. Use 1-back
	// to make the lag a meaningful real number (ledger interval).
	finalIdx := 1
	if len(parsed.Embedded.Records) > 1 {
		finalIdx = 1
	}
	final := parsed.Embedded.Records[finalIdx]

	latestTs, err := time.Parse(time.RFC3339, latest.ClosedAt)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_ts: %v", err)
		return s
	}
	finalTs, err := time.Parse(time.RFC3339, final.ClosedAt)
	if err != nil {
		s.Err = fmt.Sprintf("parse_final_ts: %v", err)
		return s
	}

	s.LatestBlock = int64(latest.Sequence)
	s.FinalizedBlock = int64(final.Sequence)
	s.BlockLag = s.LatestBlock - s.FinalizedBlock
	s.LagSeconds = latestTs.Sub(finalTs).Seconds()
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}
