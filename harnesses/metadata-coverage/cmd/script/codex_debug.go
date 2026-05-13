package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// codexDebugEntry is a single Codex GraphQL call captured for debugging.
type codexDebugEntry struct {
	At         string `json:"at"`
	Chain      string `json:"chain"`
	Address    string `json:"address"`
	StatusCode int    `json:"status_code"`
	LatencyMs  int    `json:"latency_ms"`
	Error      string `json:"error,omitempty"`
	BodySample string `json:"body_sample,omitempty"`
}

const codexDebugBufferSize = 20

var (
	codexDebugMu     sync.Mutex
	codexDebugBuffer = make([]codexDebugEntry, 0, codexDebugBufferSize)
	codexLastJWTLen  int
	codexLastJWTAt   string
	codexLastJWTErr  string
)

func recordCodexCall(entry codexDebugEntry) {
	codexDebugMu.Lock()
	defer codexDebugMu.Unlock()
	if len(codexDebugBuffer) >= codexDebugBufferSize {
		codexDebugBuffer = append(codexDebugBuffer[1:], entry)
		return
	}
	codexDebugBuffer = append(codexDebugBuffer, entry)
}

func recordCodexJWT(tokenLen int, err string) {
	codexDebugMu.Lock()
	defer codexDebugMu.Unlock()
	codexLastJWTLen = tokenLen
	codexLastJWTAt = time.Now().UTC().Format(time.RFC3339)
	codexLastJWTErr = err
}

func setupCodexDebugEndpoint(mux *http.ServeMux) {
	mux.HandleFunc("/debug/codex", func(w http.ResponseWriter, r *http.Request) {
		codexDebugMu.Lock()
		entries := make([]codexDebugEntry, len(codexDebugBuffer))
		copy(entries, codexDebugBuffer)
		jwt := struct {
			LastTokenLength int    `json:"last_token_length"`
			LastMintAt      string `json:"last_mint_at"`
			LastMintError   string `json:"last_mint_error,omitempty"`
		}{codexLastJWTLen, codexLastJWTAt, codexLastJWTErr}
		codexDebugMu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jwt":        jwt,
			"recent":     entries,
			"buffer_max": codexDebugBufferSize,
		})
	})
}
