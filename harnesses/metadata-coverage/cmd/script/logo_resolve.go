package main

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The bench scores the logo field as "did the provider return a non-empty
// string". That is not the same question as "does this token have a logo",
// and the difference is not academic: Mobula rewrites every logo onto
// metadata.mobula.io at a deterministic path derived from chain and
// address, so its logo field is non-empty for every token by construction,
// whether or not an image exists behind the URL. Providers that return the
// upstream source URL (ipfs.io, cdn.dexscreener.com, launchpad CDNs, twimg)
// are scored on whether the upstream actually has the asset.
//
// Measured when this was written: Mobula 100% logo on all three chains,
// against 22.9% / 37.8% / 78.9% for a provider returning upstream URLs. A
// HEAD sweep of 12 distinct Mobula logo URLs resolved 11 and 404'd 1.
//
// Any provider can win the current rule by rewriting to its own CDN, and
// the current beneficiary is our own product, so this is published as a
// SEPARATE `logo_resolved` field rather than silently redefining `logo`.
// The existing series and its history stay intact; the stricter one builds
// alongside until there is enough of it to move the headline in a
// documented change.

var logoHTTPClient = &http.Client{
	Timeout: 4 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

type logoCacheEntry struct {
	ok bool
	at time.Time
}

var (
	logoCacheMu sync.Mutex
	logoCache   = map[string]logoCacheEntry{}
)

const (
	logoCacheTTL     = 6 * time.Hour
	logoCacheMaxSize = 20000
)

// logoResolves reports whether the URL actually serves an image. Empty
// URLs are false without a request. Results are cached because launchpad
// and CDN URLs repeat heavily across fresh tokens and we should not hammer
// third-party hosts from a monitor.
func logoResolves(rawURL string) bool {
	u := strings.TrimSpace(rawURL)
	if u == "" {
		return false
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		// data: URIs and relative paths are not verifiable from here.
		// Count them as unresolved rather than silently passing.
		return false
	}

	logoCacheMu.Lock()
	if e, ok := logoCache[u]; ok && time.Since(e.at) < logoCacheTTL {
		logoCacheMu.Unlock()
		return e.ok
	}
	logoCacheMu.Unlock()

	ok := probeLogo(u)

	logoCacheMu.Lock()
	if len(logoCache) >= logoCacheMaxSize {
		logoCache = map[string]logoCacheEntry{}
	}
	logoCache[u] = logoCacheEntry{ok: ok, at: time.Now()}
	logoCacheMu.Unlock()
	return ok
}

func probeLogo(u string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
	if err != nil {
		return false
	}
	req.Header.Set("User-Agent", "OpenChainBench-logo-probe/1.0 (+https://openchainbench.com)")
	resp, err := logoHTTPClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return imageish(resp.Header.Get("Content-Type"))
		}
		// A number of CDNs reject HEAD with 403/405 while serving GET
		// fine. Retry those with a 1-byte ranged GET rather than
		// recording a false negative.
		if resp.StatusCode != http.StatusMethodNotAllowed && resp.StatusCode != http.StatusForbidden {
			return false
		}
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel2()
	req2, err := http.NewRequestWithContext(ctx2, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	req2.Header.Set("User-Agent", "OpenChainBench-logo-probe/1.0 (+https://openchainbench.com)")
	req2.Header.Set("Range", "bytes=0-0")
	resp2, err := logoHTTPClient.Do(req2)
	if err != nil {
		return false
	}
	defer resp2.Body.Close()
	if resp2.StatusCode >= 200 && resp2.StatusCode < 300 {
		return imageish(resp2.Header.Get("Content-Type"))
	}
	return false
}

// imageish accepts anything that plausibly renders in an <img>. An empty
// Content-Type is accepted because several IPFS gateways omit it on
// ranged responses; a hard reject there would penalise providers that
// return honest upstream URLs, which is the opposite of the point.
func imageish(ct string) bool {
	c := strings.ToLower(strings.TrimSpace(ct))
	if c == "" {
		return true
	}
	if i := strings.IndexByte(c, ';'); i >= 0 {
		c = strings.TrimSpace(c[:i])
	}
	switch {
	case strings.HasPrefix(c, "image/"):
		return true
	case c == "binary/octet-stream", c == "application/octet-stream":
		return true
	}
	return false
}
