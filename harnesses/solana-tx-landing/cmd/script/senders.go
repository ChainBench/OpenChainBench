package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/gagliardetto/solana-go"
)

// Shared HTTP client. Reusing one client keeps the TCP+TLS pool warm
// across cycles → realistic POP latency reported in the bench.
var senderHTTPClient = &http.Client{Timeout: senderHTTPTimeout}

// Regex that scrubs secret-bearing query params from any string we
// print in error logs. Upstream services sometimes echo the request
// URL or `?api-key=…` portion of it inside their 4xx HTML page.
var secretQueryParamRE = regexp.MustCompile(`(?i)((?:api[-_]?key|c)=)[^\s"&<>]+`)

// Slack webhook URLs have the form
// https://hooks.slack.com/services/Txxx/Bxxx/<token>. The token is a
// shared secret — mask it whenever a URL appears in an error message.
var slackWebhookRE = regexp.MustCompile(`(hooks\.slack\.com/services/[^/\s]+/[^/\s]+/)[A-Za-z0-9]+`)

func scrubSecrets(s string) string {
	s = secretQueryParamRE.ReplaceAllString(s, "${1}***")
	s = slackWebhookRE.ReplaceAllString(s, "${1}***")
	return s
}

// Per-service transaction submission. Each service has its own URL,
// auth pattern, body shape, and tip floor — methodology §3 freezes
// the tip floor per service; senders.go encodes the wire shape.
//
// Conventions:
//   • POST JSON-RPC 2.0 sendTransaction
//   • tx encoded as base64 (mandatory for Nozomi, accepted by others)
//   • skipPreflight=true + maxRetries=0 wherever the service accepts
//     them (mandatory for Helius)
//   • 5 s HTTP timeout — services that don't respond in 5 s are
//     classified as network_error
//
// API keys for Nozomi / Astralane / 0slot are loaded from env. A
// missing key skips that service silently — the prober continues
// with whatever is available.

const senderHTTPTimeout = 5 * time.Second

// JSON-RPC envelope shared across sendTransaction calls. Helius /
// Astralane / 0slot add extra fields; we hand-build the body where
// the shape diverges from canonical.
type sendTxReq struct {
	Jsonrpc string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type sendTxResp struct {
	Result *string `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// buildProbes assembles the slice of serviceProbe ready for the prober
// loop. Filters by `enabled` if non-nil; skips services whose required
// API key is missing.
func buildProbes(enabled map[Service]bool) ([]serviceProbe, error) {
	tipWallets, err := pickTipWallets()
	if err != nil {
		return nil, err
	}

	candidates := []serviceProbe{
		buildJitoProbe(tipWallets[ServiceJito]),
		buildHeliusSwqosProbe(tipWallets[ServiceHeliusSender]),
		buildNozomiProbe(tipWallets[ServiceNozomi]),
		buildAstralaneProbe(tipWallets[ServiceAstralane]),
		buildZeroSlotProbe(tipWallets[Service0slot]),
		// Mobula has no own tip wallet (relays via Jito/Nozomi/zeroslot internally).
		// Embed a Jito tip transfer so Mobula's default routing sees a valid tip;
		// attribution uses signatureSubscribe (active probe path), not tip-wallet.
		buildMobulaProbe(tipWallets[ServiceJito]),
	}

	out := make([]serviceProbe, 0, len(candidates))
	for _, p := range candidates {
		if p.Endpoint == "" {
			// service skipped — usually missing API key. Already
			// logged at build time.
			continue
		}
		if enabled != nil && !enabled[p.Service] {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// pickTipWallets returns the first tip wallet per service from
// wallets.go, decoded to solana.PublicKey. We keep a single wallet per
// service in V0-Lean — randomization is a v1 anti-fingerprint feature.
func pickTipWallets() (map[Service]solana.PublicKey, error) {
	out := map[Service]solana.PublicKey{}
	for svc, wallets := range walletsByService() {
		if len(wallets) == 0 {
			continue
		}
		pk, err := solana.PublicKeyFromBase58(wallets[0])
		if err != nil {
			return nil, fmt.Errorf("decode tip wallet %s for %s: %w", wallets[0], svc, err)
		}
		out[svc] = pk
	}
	return out, nil
}

// -----------------------------------------------------------------------------
// Jito Block Engine — no key needed, optional UUID for higher rate limit.
// docs.jito.wtf/lowlatencytxnsend/
// -----------------------------------------------------------------------------

func buildJitoProbe(tip solana.PublicKey) serviceProbe {
	const url = "https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions"
	uuid := strings.TrimSpace(os.Getenv("JITO_AUTH_UUID"))
	tipLamports := uint64(envInt("JITO_TIP_LAMPORTS", 10_000))

	return serviceProbe{
		Service:     ServiceJito,
		Mode:        "default",
		Endpoint:    url,
		TipWallet:   tip,
		TipLamports: tipLamports,
		Sender: func(ctx context.Context, tx *solana.Transaction) (string, error) {
			body, err := canonicalSendTxBody(tx, false /* skipPreflight option not required */)
			if err != nil {
				return "", err
			}
			return postJSONRPC(ctx, url, body, uuid)
		},
	}
}

// -----------------------------------------------------------------------------
// Helius Sender — no key for 50 TPS default. We use the SWQOS-only mode in
// V0-Lean (isolates Helius own path from Jito fan-out per methodology §6).
// helius.dev/docs/sending-transactions/sender
// -----------------------------------------------------------------------------

func buildHeliusSwqosProbe(tip solana.PublicKey) serviceProbe {
	const url = "http://ewr-sender.helius-rpc.com/fast?swqos_only=true"
	// Use 10k for parity with Jito tip floor (Helius doc min is 5k).
	tipLamports := uint64(envInt("HELIUS_TIP_LAMPORTS", 10_000))

	return serviceProbe{
		Service:     ServiceHeliusSender,
		Mode:        "swqos_only",
		Endpoint:    url,
		TipWallet:   tip,
		TipLamports: tipLamports,
		Sender: func(ctx context.Context, tx *solana.Transaction) (string, error) {
			body, err := canonicalSendTxBody(tx, true /* Helius requires skipPreflight=true + maxRetries=0 */)
			if err != nil {
				return "", err
			}
			return postJSONRPC(ctx, url, body, "")
		},
	}
}

// -----------------------------------------------------------------------------
// Nozomi (Temporal Labs)
// use.temporal.xyz/nozomi/batch-send
//
// Wire shape (per Jakob @ Temporal Labs + public docs, 2026-05-24):
//   - Endpoint: POST /api/sendBatch?c=<KEY> on use.temporal.xyz
//   - Content-Type: application/octet-stream
//   - Body: concatenation of length-prefixed transactions in raw binary
//     `[u16_BE_len][tx_bytes]…` — single-tx submission wraps one entry.
//   - Jakob: "burst is flexible enough to handle multiple txs, but it
//     can handle a single one as well, that's actually the main approach
//     ppl use".
//
// Tip wallet pick: per Jakob, the high-traffic main wallets (TEMPaMe…)
// get saturated. We default to a non-saturated wallet declared first in
// walletsByService() so pickTipWallets() picks it up.
// -----------------------------------------------------------------------------

func buildNozomiProbe(tip solana.PublicKey) serviceProbe {
	key := strings.TrimSpace(os.Getenv("NOZOMI_API_KEY"))
	if key == "" {
		fmt.Println("[prober] nozomi: NOZOMI_API_KEY not set — service skipped")
		return serviceProbe{}
	}
	// `use.temporal.xyz` hosts the docs site (Vercel) and returns 405 for
	// POST. The actual batch-send API lives on the same geo-routed host
	// as the JSON-RPC endpoint (`edge.nozomi.temporal.xyz`), just on the
	// `/api/sendBatch` path with binary framing.
	host := envDefault("NOZOMI_ENDPOINT", "http://edge.nozomi.temporal.xyz/api/sendBatch")
	url := host + "?c=" + key
	tipLamports := uint64(envInt("NOZOMI_TIP_LAMPORTS", 1_000_000))

	return serviceProbe{
		Service:     ServiceNozomi,
		Mode:        "default",
		Endpoint:    url,
		TipWallet:   tip,
		TipLamports: tipLamports,
		Sender: func(ctx context.Context, tx *solana.Transaction) (string, error) {
			return postNozomiBatch(ctx, url, tx)
		},
	}
}

// postNozomiBatch serializes a single tx into Nozomi's length-prefixed
// binary batch format and POSTs it. Returns the locally-computed
// signature (known once tx.Sign ran) since this endpoint doesn't echo
// a sig in the response. 4xx/5xx HTTP responses surface as an error
// classified by the prober's drop-reason logic (rate_limited / invalid /
// network_error).
func postNozomiBatch(ctx context.Context, url string, tx *solana.Transaction) (string, error) {
	txBytes, err := tx.MarshalBinary()
	if err != nil {
		return "", fmt.Errorf("marshal tx: %w", err)
	}
	if len(txBytes) > 0xFFFF {
		return "", fmt.Errorf("tx %d bytes exceeds u16 length prefix", len(txBytes))
	}
	body := make([]byte, 2+len(txBytes))
	body[0] = byte(len(txBytes) >> 8)
	body[1] = byte(len(txBytes))
	copy(body[2:], txBytes)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := senderHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("nozomi batch %d: %s",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 300)))
	}
	if len(tx.Signatures) == 0 {
		return "", fmt.Errorf("no signature on tx after submission")
	}
	return tx.Signatures[0].String(), nil
}

// -----------------------------------------------------------------------------
// Astralane Iris — non-canonical 3-element params (third elem mevProtect).
// astralane.gitbook.io/docs/low-latency/submit-transactions
// -----------------------------------------------------------------------------

func buildAstralaneProbe(tip solana.PublicKey) serviceProbe {
	key := strings.TrimSpace(os.Getenv("ASTRALANE_API_KEY"))
	if key == "" {
		fmt.Println("[prober] astralane: ASTRALANE_API_KEY not set — service skipped")
		return serviceProbe{}
	}
	host := envDefault("ASTRALANE_ENDPOINT", "https://ny.gateway.astralane.io/iris")
	url := host + "?api-key=" + key
	// Astralane raised their min tip from 500_000 to 1_000_000 lamports
	// (observed in prober alerts 2026-05-26, "transaction tip is less than
	// min tip [1000000]"). Default to the new floor; ASTRALANE_TIP_LAMPORTS
	// env var still overrides for future bumps.
	tipLamports := uint64(envInt("ASTRALANE_TIP_LAMPORTS", 1_000_000))

	return serviceProbe{
		Service:     ServiceAstralane,
		Mode:        "default",
		Endpoint:    url,
		TipWallet:   tip,
		TipLamports: tipLamports,
		Sender: func(ctx context.Context, tx *solana.Transaction) (string, error) {
			rawB64, err := txToBase64(tx)
			if err != nil {
				return "", err
			}
			body := sendTxReq{
				Jsonrpc: "2.0",
				ID:      1,
				Method:  "sendTransaction",
				Params: []interface{}{
					rawB64,
					map[string]interface{}{
						"encoding":      "base64",
						"skipPreflight": true,
					},
					// Astralane's non-canonical third element.
					map[string]interface{}{
						"mevProtect": true,
					},
				},
			}
			return postJSONRPC(ctx, url, body, "")
		},
	}
}

// -----------------------------------------------------------------------------
// 0slot.trade — API key in `?api-key=` query param. Path is root (`/`).
// 0slot.trade/docs.php
// -----------------------------------------------------------------------------

func buildZeroSlotProbe(tip solana.PublicKey) serviceProbe {
	key := strings.TrimSpace(os.Getenv("ZEROSLOT_API_KEY"))
	if key == "" {
		fmt.Println("[prober] 0slot: ZEROSLOT_API_KEY not set — service skipped")
		return serviceProbe{}
	}
	host := envDefault("ZEROSLOT_ENDPOINT", "https://ny.0slot.trade")
	url := host + "?api-key=" + key
	tipLamports := uint64(envInt("ZEROSLOT_TIP_LAMPORTS", 1_000_000))

	return serviceProbe{
		Service:     Service0slot,
		Mode:        "default",
		Endpoint:    url,
		TipWallet:   tip,
		TipLamports: tipLamports,
		Sender: func(ctx context.Context, tx *solana.Transaction) (string, error) {
			body, err := canonicalSendTxBody(tx, false)
			if err != nil {
				return "", err
			}
			return postJSONRPC(ctx, url, body, "")
		},
	}
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

// canonicalSendTxBody builds the standard 2-element-params sendTransaction
// body. heliusStrict adds skipPreflight=true + maxRetries=0 which Helius
// requires; other services accept it without complaint.
func canonicalSendTxBody(tx *solana.Transaction, heliusStrict bool) (sendTxReq, error) {
	rawB64, err := txToBase64(tx)
	if err != nil {
		return sendTxReq{}, err
	}
	opts := map[string]interface{}{
		"encoding": "base64",
	}
	if heliusStrict {
		opts["skipPreflight"] = true
		opts["maxRetries"] = 0
	}
	return sendTxReq{
		Jsonrpc: "2.0",
		ID:      1,
		Method:  "sendTransaction",
		Params:  []interface{}{rawB64, opts},
	}, nil
}

func txToBase64(tx *solana.Transaction) (string, error) {
	raw, err := tx.MarshalBinary()
	if err != nil {
		return "", fmt.Errorf("marshal tx: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// postJSONRPC handles the POST + body marshal + response decode. The
// optional jitoAuthUUID adds the x-jito-auth header for Jito only.
//
// Error messages are scrubbed of secret-bearing query params via
// scrubSecrets — upstream services sometimes echo the request URL or
// auth-bearing portion of it inside their 4xx HTML pages.
func postJSONRPC(ctx context.Context, url string, body sendTxReq, jitoAuthUUID string) (string, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal req: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, senderHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, "POST", url, bytes.NewReader(buf))
	if err != nil {
		return "", fmt.Errorf("new req: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if jitoAuthUUID != "" {
		req.Header.Set("x-jito-auth", jitoAuthUUID)
	}

	resp, err := senderHTTPClient.Do(req)
	if err != nil {
		// http.Client.Do error messages include the URL.
		return "", fmt.Errorf("http: %s", scrubSecrets(err.Error()))
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	// Rate-limit short-circuit. 419 (0slot custom) + 429 (standard) +
	// some 4xx Cloudflare pages. Returned with explicit phrasing so
	// classifyDropReason maps to reason="rate_limited".
	if resp.StatusCode == 419 || resp.StatusCode == 429 {
		return "", fmt.Errorf("http %d (rate limit): %s",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)))
	}
	if resp.StatusCode >= 500 {
		return "", fmt.Errorf("http %d: %s",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)))
	}

	var parsed sendTxResp
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("decode resp (status=%d body=%s): %w",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)), err)
	}
	if parsed.Error != nil {
		return "", fmt.Errorf("rpc error %d: %s", parsed.Error.Code, scrubSecrets(parsed.Error.Message))
	}
	if parsed.Result == nil {
		return "", fmt.Errorf("nil result (status=%d body=%s)",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)))
	}
	return *parsed.Result, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// -----------------------------------------------------------------------------
// Mobula swap-send — multi-RPC fan-out aggregator
// docs.mobula.io/rest-api-reference/endpoint/swap-send
//
// Wire shape (verified 2026-05-27):
//   - POST https://api.mobula.io/api/2/swap/send
//   - Authorization: Bearer <MOBULA_API_KEY>
//   - Body: {"chainId": "solana:solana", "signedTransaction": "<base64>"}
//   - Response on success: {"data": {"transactionHash": "<sig>", "requestId": "...",
//                                    "success": true, "lander": "jito|nozomi|..."}}
//   - 201 returned for accepted submission; downstream failure surfaces inside
//     the JSON body via `error` / `data.success=false`.
//
// Mobula relays internally to Jito / Nozomi / zeroslot via multi-RPC fan-out,
// so there is no dedicated Mobula tip wallet. The probe embeds a Jito tip
// transfer (same wallet as the Jito control probe) so Mobula's default
// routing sees a valid tip on the underlying lander. Active-probe attribution
// works via signatureSubscribe on the tx signature, independent of the tip
// wallet used.
// -----------------------------------------------------------------------------

func buildMobulaProbe(tip solana.PublicKey) serviceProbe {
	key := strings.TrimSpace(os.Getenv("MOBULA_API_KEY"))
	if key == "" {
		fmt.Println("[prober] mobula: MOBULA_API_KEY not set — service skipped")
		return serviceProbe{}
	}
	url := envDefault("MOBULA_ENDPOINT", "https://api.mobula.io/api/2/swap/send")
	tipLamports := uint64(envInt("MOBULA_TIP_LAMPORTS", 10_000))

	return serviceProbe{
		Service:     ServiceMobula,
		Mode:        "default",
		Endpoint:    url,
		TipWallet:   tip,
		TipLamports: tipLamports,
		Sender: func(ctx context.Context, tx *solana.Transaction) (string, error) {
			return postMobulaSwapSend(ctx, url, key, tx)
		},
	}
}

func postMobulaSwapSend(ctx context.Context, url, apiKey string, tx *solana.Transaction) (string, error) {
	txB64, err := txToBase64(tx)
	if err != nil {
		return "", err
	}
	reqBody := map[string]any{
		"chainId":           "solana:solana",
		"signedTransaction": txB64,
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal req: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, senderHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return "", fmt.Errorf("new req: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := senderHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("http: %s", scrubSecrets(err.Error()))
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 419 || resp.StatusCode == 429 {
		return "", fmt.Errorf("http %d (rate limit): %s",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)))
	}
	if resp.StatusCode >= 500 {
		return "", fmt.Errorf("http %d: %s",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)))
	}

	var parsed struct {
		Data struct {
			TransactionHash string `json:"transactionHash"`
			Success         bool   `json:"success"`
		} `json:"data"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("decode resp (status=%d body=%s): %w",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)), err)
	}
	if parsed.Error != "" {
		return "", fmt.Errorf("mobula: %s", scrubSecrets(parsed.Error))
	}
	if parsed.Data.TransactionHash != "" {
		return parsed.Data.TransactionHash, nil
	}
	// Mobula sometimes returns 201 without echoing the sig. Fall back to
	// the locally-computed signature (known once tx.Sign ran).
	if len(tx.Signatures) == 0 {
		return "", fmt.Errorf("no signature in response or on tx (status=%d body=%s)",
			resp.StatusCode, scrubSecrets(truncate(string(respBody), 200)))
	}
	return tx.Signatures[0].String(), nil
}
