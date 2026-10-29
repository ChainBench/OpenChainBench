package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"html"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
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
	reBilling = regexp.MustCompile(`(?i)MAU|MAW|active (user|wallet)|signature|operation|\bops?\b|credit|wallets?\b|transactions?|requests?|included|free|per |up to`)
	// A tier band printed as a bare range ("1,001-5,000", "500 – 2,499",
	// "10,000,000+") carries a price boundary with no word beside it.
	reRange = regexp.MustCompile(`^\d[\d,.]*\s*(?:[-–]\s*\d[\d,.]*|\+)$`)
)

// pricingLines reduces a page to the sentences a price lives on.
//
// The unit is the sentence, not the text node. Privy states its whole
// pay-as-you-go schedule ("a volume PAYG base fee of $2,000; $0.05 per MAU
// above 10,000 MAUs; and $0.01 per signature above 50,000 signatures") in
// one FAQ paragraph of 400-odd characters, and a per-line length cap dropped
// it whole, so the six bills that rest on those rates were outside the drift
// check (audit 2026-10-29). Splitting at sentence and clause ends keeps each
// figure with its own words while the cap still drops runaway blobs.
//
// `phrases` pins wording that carries a rule but no number: Reown's "custom
// plan" sentence is what removes it from the trading profile.
func pricingLines(body string, phrases ...string) string {
	for _, re := range reBlocks {
		body = re.ReplaceAllString(body, " ")
	}
	body = reTag.ReplaceAllString(body, "\n")
	body = html.UnescapeString(body)
	lowered := make([]string, 0, len(phrases))
	for _, ph := range phrases {
		if ph = strings.ToLower(strings.TrimSpace(ph)); ph != "" {
			lowered = append(lowered, ph)
		}
	}
	set := map[string]bool{}
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(reSpace.ReplaceAllString(l, " "))
		// A pinned phrase keeps its whole text node, not its sentence: the
		// rule is often two sentences ("Are you an exchange, custodian ...
		// platform? You'll need a custom plan."), and the half that names
		// who is excluded carries no pinnable word of its own.
		pinned := false
		for _, ph := range lowered {
			if strings.Contains(strings.ToLower(l), ph) && len([]rune(l)) <= 600 {
				set[l] = true
				pinned = true
			}
		}
		if pinned {
			continue
		}
		for _, s := range sentences(l) {
			if s == "" || len([]rune(s)) > 300 {
				continue
			}
			if strings.Contains(s, "$") || (reDigit.MatchString(s) && reBilling.MatchString(s)) || reRange.MatchString(s) {
				set[s] = true
			}
		}
	}
	lines := make([]string, 0, len(set))
	for l := range set {
		lines = append(lines, l)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// sentences splits at ". ", "; ", "! " and "? ", keeping the mark with the
// sentence before it. A decimal ("$0.05") has no space after its point, so
// it is never split.
func sentences(l string) []string {
	var out []string
	start := 0
	r := []rune(l)
	for i := 0; i+1 < len(r); i++ {
		switch r[i] {
		case '.', ';', '!', '?':
			if r[i+1] == ' ' {
				out = append(out, strings.TrimSpace(string(r[start:i+1])))
				start = i + 2
			}
		}
	}
	if start < len(r) {
		out = append(out, strings.TrimSpace(string(r[start:])))
	}
	return out
}

func pricingHash(body string, phrases ...string) string {
	sum := sha256.Sum256([]byte(pricingLines(body, phrases...)))
	return hex.EncodeToString(sum[:])
}

type fetchResult struct {
	ok    bool
	sum   string
	lines string
}

func fetchBody(url string, phrases ...string) fetchResult {
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
	lines := pricingLines(string(body), phrases...)
	if lines == "" {
		// A page that answers 200 with no pricing line at all (a bot wall,
		// an empty JS shell) is not the page a human read.
		log.Printf("artifact %s: no pricing line in the body", url)
		return fetchResult{}
	}
	sum := sha256.Sum256([]byte(lines))
	return fetchResult{ok: true, sum: hex.EncodeToString(sum[:]), lines: lines}
}

type artifactState struct {
	ok     bool
	drift  bool
	age    time.Duration
	polled bool
}

func checkArtifact(a Artifact, fetch func(string, ...string) fetchResult) artifactState {
	st := artifactState{}
	if t, err := time.Parse("2006-01-02", a.VerifiedAt); err == nil {
		st.age = time.Since(t)
	}
	if !a.Poll {
		return st
	}
	st.polled = true
	r := fetch(a.URL, a.PinPhrases...)
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

var reNumber = regexp.MustCompile(`\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b`)

// unpinnedFigures lists the catalogue figures of one vendor (fees, rates,
// band edges, caps, quote thresholds) that appear nowhere in its page's
// hashed lines. "2.5k" and "2,500" are the same figure. Used by
// WALLET_COST_PIN to show what a drift check could miss.
func unpinnedFigures(p Provider, lines string) []string {
	have := map[float64]bool{}
	for _, m := range reNumber.FindAllString(lines, -1) {
		s := strings.ReplaceAll(strings.TrimSpace(m), ",", "")
		mult := 1.0
		switch {
		case strings.HasSuffix(s, "k") || strings.HasSuffix(s, "K"):
			mult, s = 1e3, strings.TrimSpace(s[:len(s)-1])
		case strings.HasSuffix(s, "m") || strings.HasSuffix(s, "M"):
			mult, s = 1e6, strings.TrimSpace(s[:len(s)-1])
		}
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			have[roundFig(v*mult)] = true
		}
	}
	var missing []string
	check := func(label string, v float64) {
		if v > 0 && !have[roundFig(v)] {
			missing = append(missing, fmt.Sprintf("%s=%g", label, v))
		}
	}
	for _, pl := range p.Plans {
		if pl.MonthlyUSD != nil {
			check(pl.ID+".fee", *pl.MonthlyUSD)
		}
		for meter, tiers := range pl.Tiers {
			for i, t := range tiers {
				check(fmt.Sprintf("%s.%s[%d].rate", pl.ID, meter, i), *t.Rate)
				if t.UpTo != nil {
					check(fmt.Sprintf("%s.%s[%d].up_to", pl.ID, meter, i), *t.UpTo)
				}
			}
		}
		for meter, v := range pl.Caps {
			check(pl.ID+".cap."+meter, v)
		}
		for meter, v := range pl.QuoteAbove {
			check(pl.ID+".quote_above."+meter, v)
		}
	}
	sort.Strings(missing)
	return missing
}

func roundFig(v float64) float64 { return math.Round(v*1e6) / 1e6 }
