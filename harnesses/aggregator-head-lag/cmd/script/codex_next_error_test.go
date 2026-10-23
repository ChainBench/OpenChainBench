package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCodexNextError(t *testing.T) {
	cases := []struct {
		raw  string
		dead bool
		want string
	}{
		// Verbatim shape from iad.edge, 2026-10-23.
		{`{"type":"next","id":"headlag_0","payload":{"errors":[{"extensions":{"code":"EDGE_ORIGIN_UNAVAILABLE"},"message":"Codex origin subscription connection closed (1006)"}]}}`, true, "EDGE_ORIGIN_UNAVAILABLE"},
		{`{"type":"next","id":"headlag_0","payload":{"data":{"onEventsCreated":null},"errors":[{"message":"boom"}]}}`, true, "boom"},
		{`{"type":"next","id":"headlag_0","payload":{"data":{"onEventsCreated":{"events":[]}},"errors":[{"message":"partial"}]}}`, false, ""},
		{`{"type":"next","id":"headlag_0","payload":{"data":{"onEventsCreated":{"events":[]}}}}`, false, ""},
		{`{"type":"pong"}`, false, ""},
	}
	for _, c := range cases {
		var m CodexWSMessage
		if err := json.Unmarshal([]byte(c.raw), &m); err != nil {
			t.Fatal(err)
		}
		reason, dead := codexNextError(m)
		if dead != c.dead || !strings.Contains(reason, c.want) {
			t.Errorf("%s: got (%q, %v), want dead=%v containing %q", c.raw, reason, dead, c.dead, c.want)
		}
	}
}
