package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// One client, reused, with its own connection pool.
//
// Reuse is deliberate and so is the pool size: an accidental shared
// connection made three keyed RPC providers publish 4 to 6 times too slow
// on 2026-10-08, and the opposite mistake, a fresh connection per probe,
// measures TLS setup instead of the service.
var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	},
}

// ok2xx is why this helper exists rather than a bare status comparison.
// 1Click answers 201 Created for a dry quote, and a probe that tested for
// 200 read that as a refusal and was about to publish the opposite of the
// truth about shielded payouts.
func ok2xx(code int) bool { return code >= 200 && code < 300 }

const userAgent = "OpenChainBench/privacy-rails (+https://openchainbench.com)"

// getJSON issues a GET and decodes into out. The HTTP status is returned so
// a caller can tell a refusal apart from a transport failure: a rail that
// answers 400 with a reason is information, a dial timeout is not.
func getJSON(url string, out interface{}) (int, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	return doJSON(req, out)
}

func postJSON(url string, body interface{}, out interface{}) (int, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	return doJSON(req, out)
}

func doJSON(req *http.Request, out interface{}) (int, error) {
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if out == nil {
		return resp.StatusCode, nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		// Carry a slice of the body: a Cloudflare challenge and an API error
		// both arrive as "not JSON" and only one of them is worth retrying.
		snip := raw
		if len(snip) > 160 {
			snip = snip[:160]
		}
		return resp.StatusCode, fmt.Errorf("decode: %w (body %q)", err, snip)
	}
	return resp.StatusCode, nil
}
