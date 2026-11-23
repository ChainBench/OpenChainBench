package main

import (
	"strings"
	"testing"
)

// Six of thirteen source pages return a new body on every request while the
// prices stand still. The reduction must ignore that churn and still move
// when a price does.
func TestPricingLinesIgnoreChurnButNotPrices(t *testing.T) {
	page := func(nonce, price string) string {
		return `<html><head><script>window.__BUILD="` + nonce + `"</script><style>.a{}</style></head>
<body><div data-id="` + nonce + `"><h2>Growth</h2><p>` + price + `/month</p><p>Up to 5,000 MAU</p>
<svg><text>$999</text></svg></div></body></html>`
	}
	a := pricingHash(page("abc", "$249"))
	b := pricingHash(page("xyz", "$249"))
	if a != b {
		t.Fatalf("a build id changed the hash")
	}
	if c := pricingHash(page("abc", "$299")); c == a {
		t.Fatalf("a price change did not change the hash")
	}
	if got := pricingLines(page("abc", "$249")); got != "$249/month\nUp to 5,000 MAU" {
		t.Fatalf("pricing lines = %q", got)
	}
}

func TestFailedFetchKeepsNoFreshVerdict(t *testing.T) {
	a := Artifact{URL: "https://example.test", BodySHA256: "recorded", VerifiedAt: "2026-10-29", Poll: true}
	if st := checkArtifact(a, func(string, ...string) fetchResult { return fetchResult{} }); !st.polled || st.ok || st.drift {
		t.Fatalf("failed fetch: %+v", st)
	}
	if st := checkArtifact(a, func(string, ...string) fetchResult { return fetchResult{ok: true, sum: "other"} }); !st.drift {
		t.Fatalf("changed lines not flagged")
	}
	if st := checkArtifact(a, func(string, ...string) fetchResult { return fetchResult{ok: true, sum: "recorded"} }); st.drift {
		t.Fatalf("unchanged lines flagged")
	}
}

// Privy states its pay-as-you-go schedule in one FAQ paragraph longer than
// the length cap. Split into sentences, every figure in it is hashed, so an
// edit to any of them is a drift.
func TestLongParagraphFiguresAreHashed(t *testing.T) {
	para := func(base string) string {
		return `<p>Regardless of what plan you are on, you can scale your user base and usage with peace of mind. ` +
			`Privy offers different tiers of pricing as your usage grows. If your usage exceeds 10,000 MAU or 50,000 signatures in a given month, ` +
			`pay-as-you-go pricing for additional usage will apply: a volume PAYG base fee of ` + base + `; $0.05 per MAU above 10,000 MAUs; ` +
			`and $0.01 per signature above 50,000 signatures. If you anticipate sustained PAYG volume over multiple months, reach out.</p>`
	}
	lines := pricingLines(para("$2,000"))
	for _, want := range []string{"$2,000", "$0.05 per MAU above 10,000 MAUs", "$0.01 per signature above 50,000 signatures"} {
		if !strings.Contains(lines, want) {
			t.Fatalf("%q missing from the hashed lines:\n%s", want, lines)
		}
	}
	if pricingHash(para("$2,000")) == pricingHash(para("$2,500")) {
		t.Fatalf("a base fee change in the long paragraph did not move the hash")
	}
}

// A rule with no number in it is hashed only when its page pins the phrase.
func TestPinnedPhraseIsHashed(t *testing.T) {
	page := func(who string) string {
		return `<p>Are you an ` + who + ` platform? You'll need a custom plan.</p><p>$89/month</p>`
	}
	if pricingHash(page("exchange")) != pricingHash(page("gaming")) {
		t.Fatalf("unpinned: wording without a number should not be hashed")
	}
	if pricingHash(page("exchange"), "custom plan") == pricingHash(page("gaming"), "custom plan") {
		t.Fatalf("pinned: an edit to the custom-plan sentence did not move the hash")
	}
}

func TestSentencesKeepDecimals(t *testing.T) {
	got := sentences("Each costs $0.005. Then 1.5x more; or not")
	want := []string{"Each costs $0.005.", "Then 1.5x more;", "or not"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("sentences = %q", got)
	}
}

func TestBandEdgesAreHashed(t *testing.T) {
	page := func(edge string) string {
		return `<td>1,001-` + edge + `</td><td>$0.050/each</td><td>Up to 2,500</td><td>10,000,000+</td>`
	}
	lines := pricingLines(page("5,000"))
	for _, want := range []string{"1,001-5,000", "Up to 2,500", "10,000,000+"} {
		if !strings.Contains(lines, want) {
			t.Fatalf("%q not hashed:\n%s", want, lines)
		}
	}
	if pricingHash(page("5,000")) == pricingHash(page("6,000")) {
		t.Fatalf("a band edge change did not move the hash")
	}
}
