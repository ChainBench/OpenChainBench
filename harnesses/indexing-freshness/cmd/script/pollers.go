package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Detection is deliberately parser-free: we lowercase the raw response
// body and look for the tx hash substring. Every cohort API returns the
// hash verbatim in its JSON, so this is immune to per-provider schema
// churn and cannot be accused of favouring any response shape.
func bodyContains(resp *http.Response, txHash string) (bool, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return false, err
	}
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("status %d", resp.StatusCode)
	}
	return bytes.Contains(bytes.ToLower(raw), []byte(strings.ToLower(txHash))), nil
}

var httpClient = &http.Client{Timeout: 8 * time.Second}

// checkProvider asks one provider's wallet API whether it has indexed
// txHash for wallet yet. Returns (found, error). Every call increments
// the quota counter regardless of outcome.
func checkProvider(slug, wallet, txHash string) (bool, error) {
	apiCalls.WithLabelValues(slug).Inc()
	key := keyFor(slug)
	var req *http.Request
	var err error

	switch slug {
	case "zerion":
		u := fmt.Sprintf("https://api.zerion.io/v1/wallets/%s/transactions/?page%%5Bsize%%5D=20&filter%%5Bchain_ids%%5D=%s", wallet, chainSlug)
		req, err = http.NewRequest("GET", u, nil)
		if err == nil {
			req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(key+":")))
			req.Header.Set("Accept", "application/json")
		}
	case "moralis":
		u := fmt.Sprintf("https://deep-index.moralis.io/api/v2.2/wallets/%s/history?chain=%s&limit=20", wallet, chainSlug)
		req, err = http.NewRequest("GET", u, nil)
		if err == nil {
			req.Header.Set("X-API-Key", key)
		}
	case "goldrush":
		u := fmt.Sprintf("https://api.covalenthq.com/v1/%s-mainnet/address/%s/transactions_v3/?page-size=20", chainSlug, wallet)
		req, err = http.NewRequest("GET", u, nil)
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	case "allium":
		body := fmt.Sprintf(`[{"chain":"%s","address":"%s","limit":20}]`, chainSlug, wallet)
		req, err = http.NewRequest("POST", "https://api.allium.so/api/v1/developer/wallet/transactions", strings.NewReader(body))
		if err == nil {
			req.Header.Set("X-API-KEY", key)
			req.Header.Set("Content-Type", "application/json")
		}
	case "mobula":
		u := fmt.Sprintf("https://api.mobula.io/api/1/wallet/transactions?wallet=%s&limit=20", wallet)
		req, err = http.NewRequest("GET", u, nil)
		if err == nil {
			req.Header.Set("Authorization", key)
		}
	default:
		return false, fmt.Errorf("unknown provider %s", slug)
	}
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	return bodyContains(resp, txHash)
}

// ---------------------------------------------------------------------------
// Monthly quota guard (same design as rpc-keyed-latency).
// ---------------------------------------------------------------------------

type quotaGuard struct {
	mu     sync.Mutex
	month  string
	counts map[string]int64
}

var quota = &quotaGuard{counts: make(map[string]int64)}

func (q *quotaGuard) allow(p Provider) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	m := time.Now().UTC().Format("2006-01")
	if m != q.month {
		q.month = m
		q.counts = make(map[string]int64)
	}
	used := q.counts[p.Slug]
	ratio := float64(used) / float64(p.Budget)
	quotaUsedRatio.WithLabelValues(p.Slug).Set(ratio)
	if ratio >= 0.90 {
		return false
	}
	// Reserve the worst case for one event (full poll schedule).
	q.counts[p.Slug] = used + int64(len(pollSchedule))
	return true
}
