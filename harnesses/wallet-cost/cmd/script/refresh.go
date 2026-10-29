package main

import (
	"crypto/sha256"
	"encoding/hex"
	"html"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Freshness, not scraping.
//
// The catalogue's figures are read by a human. This file keeps them honest:
// each cycle it re-fetches every source page, reduces it to its pricing
// lines and compares their hash with the one recorded when a human last
// read the page. A change sets wallet_pricing_artifact_drift to 1, an alarm
// for the maintainers, who re-read the page and correct the catalogue.
//
// Why not hash the raw body, as rpc-cost does: measured on 2026-10-29, six of
// the thirteen pages return a different body on every request (build ids,
// nonces, Framer and Webflow hydration state) while their prices stand still.
// A raw hash would alarm every cycle and teach everyone to ignore it. The
// reduction keeps the visible lines that carry a dollar figure, or a number
// beside a billing word (MAU, signatures, operations, credits, included,
// free...), sorted and de-duplicated. It was stable over three fetches of
// every page, and it still moves when any price or allowance does.

const userAgent = "Mozilla/5.0 (compatible; OpenChainBench/wallet-cost; +https://openchainbench.com)"

var httpClient = &http.Client{Timeout: 30 * time.Second}

var (
	reBlocks = []*regexp.Regexp{
		regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script>`),
		regexp.MustCompile(`(?is)<style\b[^>]*>.*?</style>`),
		regexp.MustCompile(`(?is)<noscript\b[^>]*>.*?</noscript>`),
		regexp.MustCompile(`(?is)<svg\b[^>]*>.*?</svg>`),
		regexp.MustCompile(`(?is)<template\b[^>]*>.*?</template>`),
	}
	reTag     = regexp.MustCompile(`(?s)<[^>]+>`)
	reSpace   = regexp.MustCompile(`\s+`)
	reDigit   = regexp.MustCompile(`\d`)
	reBilling = regexp.MustCompile(`(?i)MAU|MAW|active (user|wallet)|signature|operation|\bops?\b|credit|wallets?\b|transactions?|requests?|included|free|per `)
)

// pricingLines reduces a page to the lines a price lives on. A twin of the
// reduction in the independent scorer; the two are tested on the same pages.
func pricingLines(body string) string {
	for _, re := range reBlocks {
		body = re.ReplaceAllString(body, " ")
	}
	body = reTag.ReplaceAllString(body, "\n")
	body = html.UnescapeString(body)
	set := map[string]bool{}
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(reSpace.ReplaceAllString(l, " "))
		if l == "" || len([]rune(l)) > 300 {
			continue
		}
		if strings.Contains(l, "$") || (reDigit.MatchString(l) && reBilling.MatchString(l)) {
			set[l] = true
		}
	}
	lines := make([]string, 0, len(set))
	for l := range set {
		lines = append(lines, l)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func pricingHash(body string) string {
	sum := sha256.Sum256([]byte(pricingLines(body)))
	return hex.EncodeToString(sum[:])
}

type fetchResult struct {
	ok  bool
	sum string
}

func fetchBody(url string) fetchResult {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return fetchResult{}
	}
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
		// A body cut off mid-read is not a healthy fetch.
		log.Printf("artifact %s: read: %v", url, err)
		return fetchResult{}
	}
	lines := pricingLines(string(body))
	if lines == "" {
		// A page that answers 200 with no pricing line at all (a bot wall,
		// an empty JS shell) is not the page a human read.
		log.Printf("artifact %s: no pricing line in the body", url)
		return fetchResult{}
	}
	sum := sha256.Sum256([]byte(lines))
	return fetchResult{ok: true, sum: hex.EncodeToString(sum[:])}
}

type artifactState struct {
	ok     bool
	drift  bool
	age    time.Duration
	polled bool
}

func checkArtifact(a Artifact, fetch func(string) fetchResult) artifactState {
	st := artifactState{}
	if t, err := time.Parse("2006-01-02", a.VerifiedAt); err == nil {
		st.age = time.Since(t)
	}
	if !a.Poll {
		return st
	}
	st.polled = true
	r := fetch(a.URL)
	if !r.ok {
		// Unknown, not undrifted: the caller keeps the last verdict.
		return st
	}
	st.ok = true
	if a.BodySHA256 != "" && r.sum != a.BodySHA256 {
		st.drift = true
		log.Printf("artifact %s: DRIFT, pricing-lines sha256 %s != recorded %s", a.URL, r.sum, a.BodySHA256)
	}
	return st
}
