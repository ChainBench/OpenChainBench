package main

import (
	"net/http"
	"testing"
	"time"
)

// Each aggregator states its wait in a different header, and reading the
// wrong one means ignoring it. LI.FI uses ratelimit-reset, Trnch uses a
// policy header with its own reset, and most use Retry-After.
func TestTheWaitIsReadFromWhicheverHeaderTheyUse(t *testing.T) {
	cases := []struct {
		name string
		h    http.Header
		want time.Duration
	}{
		{"retry-after", http.Header{"Retry-After": {"120"}}, 2 * time.Minute},
		{"ratelimit-reset", http.Header{"Ratelimit-Reset": {"1229"}}, 1229 * time.Second},
		{"x-prefixed", http.Header{"X-Ratelimit-Reset": {"30"}}, 30 * time.Second},
		{"none of them", http.Header{}, time.Minute},
		{"not a number", http.Header{"Retry-After": {"Wed, 21 Oct 2026"}}, time.Minute},
	}
	for _, c := range cases {
		if got := retryAfter(c.h); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

// Retry-After wins over the reset, because it is the specific instruction and
// the reset is only when the window rolls.
func TestRetryAfterIsPreferred(t *testing.T) {
	h := http.Header{"Retry-After": {"5"}, "Ratelimit-Reset": {"900"}}
	if got := retryAfter(h); got != 5*time.Second {
		t.Errorf("got %s, want 5s", got)
	}
}

// The cooldown has to outlive a sweep. LI.FI's window is 20 minutes and ours
// is 15, so a memory that reset each sweep would walk into the same wall
// every time, which is exactly what happened on three consecutive sweeps.
func TestTheCooldownOutlivesASweep(t *testing.T) {
	cooldowns.Delete("probe")
	if _, cooling := coolingDown("probe"); cooling {
		t.Fatal("nothing recorded, nothing to wait for")
	}
	coolDown("probe", 20*time.Minute)
	wait, cooling := coolingDown("probe")
	if !cooling {
		t.Fatal("it should be cooling down")
	}
	if wait < 19*time.Minute {
		t.Errorf("the wait must survive, got %s", wait)
	}
	t.Cleanup(func() { cooldowns.Delete("probe") })
}

// Once the wait has passed, asking resumes on its own rather than needing a
// restart.
func TestItResumesWhenTheWaitHasPassed(t *testing.T) {
	cooldowns.Delete("probe2")
	coolDown("probe2", 20*time.Millisecond)
	time.Sleep(40 * time.Millisecond)
	if _, cooling := coolingDown("probe2"); cooling {
		t.Error("the window closed, asking must resume")
	}
	t.Cleanup(func() { cooldowns.Delete("probe2") })
}

// A rate limit is not a failed request and must not be counted as one: an
// unanswered request is excluded from the denominator, which is correct, but
// a limit also means stop, which a plain error does not say.
func TestARateLimitSaysHowLongToWait(t *testing.T) {
	e := &rateLimited{slug: "lifi", after: 11 * time.Minute, body: "Rate limit exceeded"}
	if e.after != 11*time.Minute {
		t.Error("the wait must be carried, not just the fact")
	}
	if msg := e.Error(); msg == "" || !contains(msg, "11m") {
		t.Errorf("the message should state the wait, got %q", msg)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		func() bool {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		}())
}
