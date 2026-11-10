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

// Codex runs four sockets (Solana, Base, Robinhood and BNB, each on an edge
// node) behind the one ws_connected{aggregator="codex"} series the spec
// reads. A healthy socket must not mask a dead one, so the series reads 1
// only while all of them are up.
func TestCodexSocketsReportConnectedOnlyWhenAllUp(t *testing.T) {
	const region = "test-codex-sockets"
	sockets := newCodexSockets(region, "solana", "base", "robinhood", "bnb")

	sockets.set("bnb", true)
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

// Every bench chain reads its edge node, each on a socket of its own, and
// no socket is opened for an endpoint nothing reads.
func TestCodexSocketPlanRoutesChainsToEndpoints(t *testing.T) {
	config := &Config{
		CodexSolanaWSURL:    "wss://fra.edge.codex.io/graphql",
		CodexBaseWSURL:      "wss://iad.edge.codex.io/graphql",
		CodexRobinhoodWSURL: "wss://iad.edge.codex.io/graphql",
		CodexBNBWSURL:       "wss://iad.edge.codex.io/graphql",
	}
	want := map[string]string{
		"solana":    config.CodexSolanaWSURL,
		"base":      config.CodexBaseWSURL,
		"robinhood": config.CodexRobinhoodWSURL,
		"bnb":       config.CodexBNBWSURL,
	}

	got := make(map[string]string)
	for _, socket := range codexSocketPlan(config, headLagPools) {
		if len(socket.pools) == 0 {
			t.Errorf("socket %q subscribes to nothing", socket.name)
		}
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

// A chain rolled back to graph.codex.io still gets a socket there.
func TestCodexSocketPlanRollbackUsesGraph(t *testing.T) {
	config := &Config{
		CodexSolanaWSURL:    "wss://fra.edge.codex.io/graphql",
		CodexBaseWSURL:      "wss://iad.edge.codex.io/graphql",
		CodexRobinhoodWSURL: "wss://iad.edge.codex.io/graphql",
		CodexBNBWSURL:       codexWSURL,
	}
	for _, socket := range codexSocketPlan(config, headLagPools) {
		if socket.name == "bnb" && socket.endpoint != codexWSURL {
			t.Errorf("bnb reads %q, want %q", socket.endpoint, codexWSURL)
		}
	}
}

// Robinhood reads Processed only on an edge node: graph.codex.io delivers
// nothing at that level there, so a rollback to graph must read the default.
// BNB reads Processed on both.
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
		{"bnb", edge, true},
		{"bnb", codexWSURL, true},
		{"unknown", codexWSURL, false},
	}
	for _, c := range cases {
		if got := codexProcessed(c.chain, c.endpoint); got != c.want {
			t.Errorf("codexProcessed(%s, %s) = %v, want %v", c.chain, c.endpoint, got, c.want)
		}
	}
}

// Every chain reads its edge node unless overridden, and the key is read
// from the environment.
func TestCodexConfigDefaults(t *testing.T) {
	t.Chdir(t.TempDir()) // no stray .env
	t.Setenv("CODEX_API_KEY", " test-key ")
	t.Setenv("CODEX_SOLANA_WS_URL", "") // empty reads as unset
	t.Setenv("CODEX_BASE_WS_URL", "")
	t.Setenv("CODEX_ROBINHOOD_WS_URL", "")
	t.Setenv("CODEX_BNB_WS_URL", "")

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
	if config.CodexBNBWSURL != "wss://iad.edge.codex.io/graphql" {
		t.Errorf("CodexBNBWSURL = %q, want the iad edge node", config.CodexBNBWSURL)
	}

	t.Setenv("CODEX_SOLANA_WS_URL", codexWSURL)
	t.Setenv("CODEX_BASE_WS_URL", codexWSURL)
	t.Setenv("CODEX_ROBINHOOD_WS_URL", codexWSURL)
	t.Setenv("CODEX_BNB_WS_URL", codexWSURL)
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
	if config.CodexBNBWSURL != codexWSURL {
		t.Errorf("override ignored: CodexBNBWSURL = %q, want %q", config.CodexBNBWSURL, codexWSURL)
	}
}
