package main

import (
	"testing"

	dto "github.com/prometheus/client_model/go"
)

func codexWSConnected(t *testing.T, region string) float64 {
	t.Helper()
	var m dto.Metric
	if err := wsConnected.WithLabelValues("codex", region).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetGauge().GetValue()
}

// Codex runs two sockets (Solana on the edge node, the other chains on
// graph.codex.io) behind the one ws_connected{aggregator="codex"} series the
// spec reads. A healthy socket must not mask a dead one, so the series reads
// 1 only while both are up.
func TestCodexSocketsReportConnectedOnlyWhenAllUp(t *testing.T) {
	const region = "test-codex-sockets"
	sockets := newCodexSockets(region, "edge", "graph")

	sockets.set("graph", true)
	if v := codexWSConnected(t, region); v != 0 {
		t.Fatalf("graph up, edge never connected: ws_connected = %v, want 0", v)
	}
	sockets.set("edge", true)
	if v := codexWSConnected(t, region); v != 1 {
		t.Fatalf("both up: ws_connected = %v, want 1", v)
	}
	sockets.set("edge", false)
	if v := codexWSConnected(t, region); v != 0 {
		t.Fatalf("edge dropped: ws_connected = %v, want 0", v)
	}
}

// The Solana subscription reads the edge node unless overridden, and the
// key is read from the environment.
func TestCodexConfigDefaults(t *testing.T) {
	t.Chdir(t.TempDir()) // no stray .env
	t.Setenv("CODEX_API_KEY", " test-key ")
	t.Setenv("CODEX_SOLANA_WS_URL", "") // empty reads as unset

	config, err := loadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.CodexAPIKey != "test-key" {
		t.Errorf("CodexAPIKey = %q, want %q", config.CodexAPIKey, "test-key")
	}
	if config.CodexSolanaWSURL != "wss://fra.edge.codex.io/graphql" {
		t.Errorf("CodexSolanaWSURL = %q, want the Frankfurt edge node", config.CodexSolanaWSURL)
	}

	t.Setenv("CODEX_SOLANA_WS_URL", codexWSURL)
	config, err = loadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.CodexSolanaWSURL != codexWSURL {
		t.Errorf("override ignored: CodexSolanaWSURL = %q, want %q", config.CodexSolanaWSURL, codexWSURL)
	}
}
