package main

import (
	"net"
	"net/http"
	"time"
)

// newWarmHTTPClient returns an http.Client wired for connection reuse.
// Per-provider timeout is enforced via context, not the client Timeout field,
// so the client can be shared across multiple concurrent requests.
func newWarmHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:          10,
			MaxIdleConnsPerHost:   3,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			ForceAttemptHTTP2:     true,
		},
	}
}
