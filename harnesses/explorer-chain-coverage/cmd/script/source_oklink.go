package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// OKLink. Free self-serve key required (Ok-Access-Key header, ~5 rps
// free tier). One aggregate call covers the whole cycle.
//
// registered + verified: GET /api/v5/explorer/blockchain/summary with
// no chainShortName returns every supported chain with lastHeight and
// lastBlockTime (epoch ms) — registered = row count, verified = rows
// whose lastBlockTime is inside the freshness window.
//
// Deprecation risk: OKLink's public data-API docs were pulled during
// the OKX OS migration; treat parse failures here as a signal to
// re-check the surface, not to patch blindly.
const oklinkBaseDefault = "https://www.oklink.com"

func probeOKLink(key string) coverage {
	base := envDefault("OKLINK_BASE_URL", oklinkBaseDefault)
	cov := coverage{registered: -1, registeredSource: "registry", verified: -1, top50: -1}
	var total time.Duration

	raw, el, err := doCall("oklink", "GET", base+"/api/v5/explorer/blockchain/summary", map[string]string{
		"Ok-Access-Key": key,
		"Accept":        "application/json",
	}, nil)
	total += el
	if err != nil {
		recordError("oklink", err)
		fmt.Printf("[oklink] blockchain summary failed: %v\n", err)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	rows, perr := parseOKLinkSummary(raw)
	if perr != nil {
		recordError("oklink", perr)
		fmt.Printf("[oklink] summary parse failed: %v\n", perr)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}

	nameLive := map[string]bool{}
	verified := 0
	for _, r := range rows {
		if freshEnough(r.lastBlock) {
			verified++
			nameLive[normalizeChainName(r.shortName)] = true
			nameLive[normalizeChainName(r.fullName)] = true
		}
	}
	cov.registered = len(rows)
	cov.verified = verified
	cov.top50 = top50Count(map[int64]bool{}, nameLive)
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

type oklinkRow struct {
	shortName string
	fullName  string
	lastBlock time.Time
}

// parseOKLinkSummary reads data[].chainShortName/chainFullName and
// lastBlockTime (epoch milliseconds as string).
func parseOKLinkSummary(raw []byte) ([]oklinkRow, error) {
	var resp struct {
		Code string `json:"code"`
		Msg  string `json:"msg"`
		Data []struct {
			ChainShortName string `json:"chainShortName"`
			ChainFullName  string `json:"chainFullName"`
			LastBlockTime  string `json:"lastBlockTime"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("parse summary: %w", err)
	}
	if resp.Code != "" && resp.Code != "0" {
		return nil, fmt.Errorf("parse summary: api code %s: %s", resp.Code, resp.Msg)
	}
	if len(resp.Data) == 0 {
		return nil, fmt.Errorf("parse summary: empty data")
	}
	out := make([]oklinkRow, 0, len(resp.Data))
	for _, d := range resp.Data {
		row := oklinkRow{shortName: d.ChainShortName, fullName: d.ChainFullName}
		if ms, err := strconv.ParseInt(d.LastBlockTime, 10, 64); err == nil && ms > 0 {
			row.lastBlock = time.UnixMilli(ms)
		}
		out = append(out, row)
	}
	return out, nil
}
