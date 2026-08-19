package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"time"
)

// proxyURL is parsed once at startup from PROBE_PROXY_URL. Nil means no proxy.
var proxyURL *url.URL

func initProxy() {
	raw := os.Getenv("PROBE_PROXY_URL")
	if raw == "" {
		return
	}
	u, err := url.Parse(raw)
	if err != nil {
		log.Printf("[proxy] bad PROBE_PROXY_URL %q: %v", raw, err)
		return
	}
	proxyURL = u
	log.Printf("[proxy] rotating proxy configured: %s://%s@%s", u.Scheme, u.User.Username(), u.Host)
}

// makeTransport returns a transport with optional proxy and any extra tweaks
// applied via functional options. Call with useProxy=true for venues blocked
// from Railway IPs.
func makeTransport(useProxy bool, opts ...func(*http.Transport)) *http.Transport {
	tr := &http.Transport{
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
	}
	if useProxy && proxyURL != nil {
		tr.Proxy = http.ProxyURL(proxyURL)
	}
	for _, opt := range opts {
		opt(tr)
	}
	return tr
}
