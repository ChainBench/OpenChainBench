package main

import "testing"

func TestCheckArtifactFailedFetchIsNotUndrifted(t *testing.T) {
	a := Artifact{URL: "https://example.test/pricing.md", BodySHA256: "recorded", Poll: "body_hash"}
	down := func(string) fetchResult { return fetchResult{} }
	st := checkArtifact(a, down)
	if !st.polled || st.ok || st.drift {
		t.Fatalf("failed fetch: got polled=%v ok=%v drift=%v, want polled, not ok, no fresh drift verdict", st.polled, st.ok, st.drift)
	}

	changed := func(string) fetchResult { return fetchResult{ok: true, sum: "different"} }
	if st := checkArtifact(a, changed); !st.ok || !st.drift {
		t.Fatalf("changed body: got ok=%v drift=%v, want ok and drift", st.ok, st.drift)
	}
	same := func(string) fetchResult { return fetchResult{ok: true, sum: "recorded"} }
	if st := checkArtifact(a, same); !st.ok || st.drift {
		t.Fatalf("unchanged body: got ok=%v drift=%v, want ok and no drift", st.ok, st.drift)
	}
}

func TestCheckArtifactManualIsNotFetched(t *testing.T) {
	called := 0
	fetch := func(string) fetchResult { called++; return fetchResult{ok: true} }
	st := checkArtifact(Artifact{URL: "https://example.test/x", Poll: "manual", VerifiedAt: "2026-10-28"}, fetch)
	if called != 0 || st.polled {
		t.Fatalf("manual artifact fetched %d times, polled=%v", called, st.polled)
	}
}
