package main

import "testing"

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
	if st := checkArtifact(a, func(string) fetchResult { return fetchResult{} }); !st.polled || st.ok || st.drift {
		t.Fatalf("failed fetch: %+v", st)
	}
	if st := checkArtifact(a, func(string) fetchResult { return fetchResult{ok: true, sum: "other"} }); !st.drift {
		t.Fatalf("changed lines not flagged")
	}
	if st := checkArtifact(a, func(string) fetchResult { return fetchResult{ok: true, sum: "recorded"} }); st.drift {
		t.Fatalf("unchanged lines flagged")
	}
}
