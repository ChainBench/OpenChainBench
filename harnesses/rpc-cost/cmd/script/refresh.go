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
// human last read it. When a provider edits its pricing page, the bench
// says so on the page — `rpc_pricing_artifact_drift` goes to 1 and the
// spec renders a "pricing changed upstream" note — instead of serving a
// stale figure that still looks authoritative.
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

func checkArtifact(a Artifact) artifactState {
	st := artifactState{}

	if a.VerifiedAt != "" {
		if t, err := time.Parse("2006-01-02", a.VerifiedAt); err == nil {
			st.age = time.Since(t)
		}
	}

	if a.URL == "" || a.Poll == "manual" {
		// Nothing to fetch, but the age still matters: a figure nobody has
		// re-read in 90 days is the thing this bench most needs to admit.
		return st
	}
	st.polled = true

	req, err := http.NewRequest(http.MethodGet, a.URL, nil)
	if err != nil {
		return st
	}
	// QuickNode's credit endpoint 403s on a default library UA, so every
	// request carries an explicit, honest one.
	req.Header.Set("User-Agent", userAgent)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("artifact %s: %v", a.URL, err)
		return st
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("artifact %s: HTTP %d", a.URL, resp.StatusCode)
		return st
	}
	st.ok = true

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return st
	}
	sum := sha256.Sum256(body)
	got := hex.EncodeToString(sum[:])

	if a.BodySHA256 != "" && got != a.BodySHA256 {
		st.drift = true
		log.Printf("artifact %s: DRIFT, body sha256 %s != recorded %s", a.URL, got, a.BodySHA256)
	}
	return st
}
