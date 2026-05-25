package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// postCycleToSlack must no-op (return nil, no HTTP call) when webhookURL
// is empty — preserves the opt-in invariant.
func TestPostCycleToSlack_NoopOnEmptyURL(t *testing.T) {
	err := postCycleToSlack(context.Background(), "", cycleSummary{})
	if err != nil {
		t.Errorf("expected nil for empty webhook URL, got: %v", err)
	}
}

// Full round-trip: spin up a fake Slack server, post a cycle summary,
// assert the JSON body has the expected blocks for both a landed probe
// and a dropped probe.
func TestPostCycleToSlack_RoundTrip(t *testing.T) {
	var receivedBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method: want POST, got %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type: %q", ct)
		}
		receivedBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	summary := cycleSummary{
		CycleID:         "deadbeef12345678",
		Region:          "us-east",
		Duration:        1500 * time.Millisecond,
		KeypairLamports: 412987128,
		SubmitSlot:      300000000,
		Results: []ProbeResult{
			{
				Service:     ServiceJito,
				Mode:        "default",
				TipLamports: 10000,
				Signature:   "5abcDEF",
				Landed:      true,
				SubmitSlot:  300000000,
				LandSlot:    300000003,
				SlotDelta:   3,
				WallMs:      1576,
			},
			{
				Service:     ServiceNozomi,
				Mode:        "default",
				TipLamports: 1000000,
				Landed:      false,
				DropReason:  "timeout",
				WallMs:      60000,
			},
		},
	}

	if err := postCycleToSlack(context.Background(), srv.URL, summary); err != nil {
		t.Fatalf("post failed: %v", err)
	}
	if receivedBody == nil {
		t.Fatal("server received no body")
	}

	var payload struct {
		Text   string                   `json:"text"`
		Blocks []map[string]interface{} `json:"blocks"`
	}
	if err := json.Unmarshal(receivedBody, &payload); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}

	// 3 base blocks (header, section, divider) + 2 probes = 5
	if got := len(payload.Blocks); got != 5 {
		t.Errorf("blocks: want 5, got %d", got)
	}

	full := string(receivedBody)
	mustContain := []string{
		"deadbeef12345678", // cycle ID in header
		"1/2 landed",       // summary
		"us-east",          // region
		"0.412987 SOL",     // balance
		"jito",             // service 1
		"explorer.solana.com/tx/5abcDEF", // sig link
		"nozomi",           // service 2
		"timeout",          // drop reason
	}
	for _, s := range mustContain {
		if !strings.Contains(full, s) {
			t.Errorf("expected body to contain %q, body: %s", s, full)
		}
	}

	// Should NOT contain raw private-key-like material or webhook tokens.
	mustNotContain := []string{
		"SOLANA_PROBE_KEYPAIR",
	}
	for _, s := range mustNotContain {
		if strings.Contains(full, s) {
			t.Errorf("body unexpectedly contains %q", s)
		}
	}
}

// scrubSecrets must redact Slack webhook tokens — the URL itself stays
// in error messages for debugging, but the secret token portion gets
// masked.
func TestScrubSecrets_SlackWebhook(t *testing.T) {
	cases := []struct {
		in, mustContain, mustNotContain string
	}{
		{
			in:             "post: dial https://hooks.slack.com/services/T12345/B67890/topSecretToken12345 failed",
			mustContain:    "hooks.slack.com/services/T12345/B67890/***",
			mustNotContain: "topSecretToken12345",
		},
		{
			in:             `error from "https://hooks.slack.com/services/Tabcd/Befgh/leakedSlackToken"`,
			mustContain:    "***",
			mustNotContain: "leakedSlackToken",
		},
	}
	for _, c := range cases {
		got := scrubSecrets(c.in)
		if !strings.Contains(got, c.mustContain) {
			t.Errorf("want substring %q in scrubbed output\n  in:  %q\n  got: %q", c.mustContain, c.in, got)
		}
		if strings.Contains(got, c.mustNotContain) {
			t.Errorf("LEAK: scrubbed output still contains %q\n  got: %q", c.mustNotContain, got)
		}
	}
}

// buildProbeBlock must format landed and dropped probes distinctly
// and never include the raw error message without scrubbing.
func TestBuildProbeBlock_FormatsLandedAndDropped(t *testing.T) {
	landed := buildProbeBlock(ProbeResult{
		Service:     ServiceJito,
		Mode:        "default",
		TipLamports: 10000,
		Signature:   "abcd1234efgh5678ijklmnop",
		Landed:      true,
		WallMs:      1500,
		SlotDelta:   3,
	})
	landedTxt := landed["text"].(map[string]interface{})["text"].(string)
	if !strings.Contains(landedTxt, "✅") || !strings.Contains(landedTxt, "1500 ms") {
		t.Errorf("landed format: %s", landedTxt)
	}
	if !strings.Contains(landedTxt, "explorer.solana.com/tx/abcd1234efgh5678ijklmnop") {
		t.Errorf("landed missing explorer link: %s", landedTxt)
	}

	dropped := buildProbeBlock(ProbeResult{
		Service:     ServiceNozomi,
		Mode:        "default",
		TipLamports: 1000000,
		Landed:      false,
		DropReason:  "rate_limited",
		ErrorMsg:    "http 429 — too many: ?api-key=ABCDEF",
	})
	droppedTxt := dropped["text"].(map[string]interface{})["text"].(string)
	if !strings.Contains(droppedTxt, "🚦") || !strings.Contains(droppedTxt, "rate_limited") {
		t.Errorf("dropped format: %s", droppedTxt)
	}
	// Critical: the API key in the error message must be scrubbed in the
	// Slack block output too (defense in depth — even if upstream code
	// forgets to scrub, the Slack reporter does).
	if strings.Contains(droppedTxt, "ABCDEF") {
		t.Errorf("SECRET LEAK in Slack block: %s", droppedTxt)
	}
}
