package main

import (
	"net"
	"net/http"
	"time"
)

// newWarmHTTPClient returns an http.Client wired for connection reuse.
//
// Bench-029 measures the steady-state RTT a long-running backend integration
// sees, not the first-request cold-start penalty. So every provider adapter
// constructs ONE shared client at boot, reuses TCP + TLS across ticks via
// keepalive, and the only thing the wallclock around `client.Do(req)`
// captures is request handling + origin work + response.
//
// Connection pool sizing assumes the harness probes one endpoint per
// provider on a 60s tick — a couple of idle connections per host is plenty.
func newWarmHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:          5,
			MaxIdleConnsPerHost:   2,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			ForceAttemptHTTP2:     true,
		},
	}
}
