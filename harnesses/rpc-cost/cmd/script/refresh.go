package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"time"
)

// Freshness, not scraping.
//
// The catalogue's numbers are human-verified. What this file does is
// keep them honest: it re-fetches every artifact those numbers came
// from, hashes the body, and compares against the hash recorded when a
// human last read it. When a provider edits its pricing page,
// `rpc_pricing_artifact_drift` goes to 1: an alarm for the maintainers,
// who re-read the page and re-commit the catalogue. Nothing on the bench
// page reads this gauge; the page shows the catalogue date.
//
// Two upstream behaviours make the obvious implementation wrong, both
// found by probing rather than by reading docs:
//
//   - Alchemy and Helius return a Last-Modified recomputed at render
//     time, so it advances on every fetch and conditional GET is
//     useless. Rule: no ETag means hash the body, never trust
//     Last-Modified.
//   - Chainstack's pricing_current.json regenerates every 15 minutes
//     unconditionally, so its hash always differs and would drift-alarm
//     forever. Artifacts like that are marked poll: manual in the
//     catalogue and only age-checked.

const userAgent = "OpenChainBench/rpc-cost (+https://openchainbench.com)"

var httpClient = &http.Client{Timeout: 30 * time.Second}

type artifactState struct {
	ok    bool
	drift bool
	age   time.Duration
	// polled is false for an artifact we deliberately do not fetch (a
	// page behind a bot wall, a JSON that regenerates every 15 minutes and
	// would drift-alarm forever). Its `ok` gauge is then not emitted at
	// all, because publishing 0 for "we never asked" reads as "the
	// provider's page is down", which is a different and untrue claim.
	polled bool
}

// fetchResult is one GET of an artifact URL. Several catalogue entries
// share a URL (Dwellir's pricing.md backs three, Chainstack's two), so a
// cycle fetches each URL once and every entry compares against that body.
type fetchResult struct {
	ok  bool
	sum string
}

func fetchBody(url string) fetchResult {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return fetchResult{}
	}
	// QuickNode's credit endpoint 403s on a default library UA, so every
	// request carries an explicit, honest one.
	req.Header.Set("User-Agent", userAgent)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("artifact %s: %v", url, err)
		return fetchResult{}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("artifact %s: HTTP %d", url, resp.StatusCode)
		return fetchResult{}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		// A body cut off mid-read is not a healthy fetch: marking ok before
		// the read published it as reachable and undrifted.
		log.Printf("artifact %s: read: %v", url, err)
		return fetchResult{}
	}
	sum := sha256.Sum256(body)
	return fetchResult{ok: true, sum: hex.EncodeToString(sum[:])}
}

// checkArtifact compares one catalogue entry against this cycle's fetch of
// its URL. `fetch` is called at most once per URL per cycle by the caller.
func checkArtifact(a Artifact, fetch func(string) fetchResult) artifactState {
	st := artifactState{}

	if a.VerifiedAt != "" {
		if t, err := time.Parse("2006-01-02", a.VerifiedAt); err == nil {
			st.age = time.Since(t)
		}
	}

	if a.URL == "" || a.Poll == "manual" {
		// Nothing to fetch, but the age still matters: it is the only thing
		// that distinguishes a manually-read figure someone checked this
		// week from one nobody has looked at in a year. Published as a
		// gauge, not compared to any threshold here.
		return st
	}
	st.polled = true

	r := fetch(a.URL)
	if !r.ok {
		// Unknown, not undrifted: the caller keeps the last drift it saw.
		return st
	}
	st.ok = true
	if a.BodySHA256 != "" && r.sum != a.BodySHA256 {
		st.drift = true
		log.Printf("artifact %s: DRIFT, body sha256 %s != recorded %s", a.URL, r.sum, a.BodySHA256)
	}
	return st
}
