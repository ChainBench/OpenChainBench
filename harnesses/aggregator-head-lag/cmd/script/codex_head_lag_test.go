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

// Codex runs four sockets (Solana, Base and Robinhood each on an edge node,
// BNB on graph.codex.io) behind the one ws_connected{aggregator="codex"}
// series the spec reads. A healthy socket must not mask a dead one, so the
// series reads 1 only while all of them are up.
func TestCodexSocketsReportConnectedOnlyWhenAllUp(t *testing.T) {
	const region = "test-codex-sockets"
	sockets := newCodexSockets(region, "solana", "base", "robinhood", "graph")

	sockets.set("graph", true)
	sockets.set("solana", true)
	sockets.set("robinhood", true)
	if v := codexWSConnected(t, region); v != 0 {
		t.Fatalf("base never connected: ws_connected = %v, want 0", v)
	}
	sockets.set("base", true)
	if v := codexWSConnected(t, region); v != 1 {
		t.Fatalf("all up: ws_connected = %v, want 1", v)
	}
	sockets.set("base", false)
	if v := codexWSConnected(t, region); v != 0 {
		t.Fatalf("base dropped: ws_connected = %v, want 0", v)
	}
}

// Solana, Base and Robinhood move to edge nodes; BNB Chain stays on
// graph.codex.io.
func TestCodexSocketPlanRoutesChainsToEndpoints(t *testing.T) {
	config := &Config{
		CodexSolanaWSURL:    "wss://fra.edge.codex.io/graphql",
		CodexBaseWSURL:      "wss://iad.edge.codex.io/graphql",
		CodexRobinhoodWSURL: "wss://iad.edge.codex.io/graphql",
	}
	want := map[string]string{
		"solana":    config.CodexSolanaWSURL,
		"base":      config.CodexBaseWSURL,
		"robinhood": config.CodexRobinhoodWSURL,
		"bnb":       codexWSURL,
	}

	got := make(map[string]string)
	for _, socket := range codexSocketPlan(config, headLagPools) {
		for _, pool := range socket.pools {
			if _, dup := got[pool.ChainName]; dup {
				t.Errorf("%s subscribed on more than one socket", pool.ChainName)
			}
			got[pool.ChainName] = socket.endpoint
		}
	}
	for chain, endpoint := range want {
		if got[chain] != endpoint {
			t.Errorf("%s reads %q, want %q", chain, got[chain], endpoint)
		}
	}
	if len(got) != len(want) {
		t.Errorf("chains subscribed = %v, want exactly %v", got, want)
	}
}

// Robinhood reads Processed only on an edge node: graph.codex.io delivers
// nothing at that level there, so a rollback to graph must read the default.
func TestCodexProcessedFollowsRobinhoodEndpoint(t *testing.T) {
	const edge = "wss://iad.edge.codex.io/graphql"
	cases := []struct {
		chain, endpoint string
		want            bool
	}{
		{"robinhood", edge, true},
		{"robinhood", codexWSURL, false},
		{"base", edge, true},
		{"base", codexWSURL, true},
		{"solana", codexWSURL, true},
		{"bnb", codexWSURL, false},
	}
	for _, c := range cases {
		if got := codexProcessed(c.chain, c.endpoint); got != c.want {
			t.Errorf("codexProcessed(%s, %s) = %v, want %v", c.chain, c.endpoint, got, c.want)
		}
	}
}

// Solana, Base and Robinhood read their edge nodes unless overridden, and
// the key is read from the environment.
func TestCodexConfigDefaults(t *testing.T) {
	t.Chdir(t.TempDir()) // no stray .env
	t.Setenv("CODEX_API_KEY", " test-key ")
	t.Setenv("CODEX_SOLANA_WS_URL", "") // empty reads as unset
	t.Setenv("CODEX_BASE_WS_URL", "")
	t.Setenv("CODEX_ROBINHOOD_WS_URL", "")

	config, err := loadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.CodexAPIKey != "test-key" {
		t.Errorf("CodexAPIKey = %q, want %q", config.CodexAPIKey, "test-key")
	}
	if config.CodexSolanaWSURL != "wss://fra.edge.codex.io/graphql" {
		t.Errorf("CodexSolanaWSURL = %q, want the fra edge node", config.CodexSolanaWSURL)
	}
	if config.CodexBaseWSURL != "wss://iad.edge.codex.io/graphql" {
		t.Errorf("CodexBaseWSURL = %q, want the iad edge node", config.CodexBaseWSURL)
	}
	if config.CodexRobinhoodWSURL != "wss://iad.edge.codex.io/graphql" {
		t.Errorf("CodexRobinhoodWSURL = %q, want the iad edge node", config.CodexRobinhoodWSURL)
	}

	t.Setenv("CODEX_SOLANA_WS_URL", codexWSURL)
	t.Setenv("CODEX_BASE_WS_URL", codexWSURL)
	t.Setenv("CODEX_ROBINHOOD_WS_URL", codexWSURL)
	config, err = loadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.CodexSolanaWSURL != codexWSURL {
		t.Errorf("override ignored: CodexSolanaWSURL = %q, want %q", config.CodexSolanaWSURL, codexWSURL)
	}
	if config.CodexBaseWSURL != codexWSURL {
		t.Errorf("override ignored: CodexBaseWSURL = %q, want %q", config.CodexBaseWSURL, codexWSURL)
	}
	if config.CodexRobinhoodWSURL != codexWSURL {
		t.Errorf("override ignored: CodexRobinhoodWSURL = %q, want %q", config.CodexRobinhoodWSURL, codexWSURL)
	}
}
