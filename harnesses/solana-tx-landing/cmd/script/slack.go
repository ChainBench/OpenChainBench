package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Slack cycle reporter — optional. Activé par env var SLACK_WEBHOOK_URL.
// Post un message Block-Kit à chaque cycle complété (succès OU drop), avec
// balance keypair, durée, et un récap par service (status, latency, slot
// delta, signature → lien Explorer, ou raison de drop si KO).
//
// Pensé pour la phase de validation Railway : tu vois en direct sur Slack
// si chaque cycle land proprement. À couper (unset SLACK_WEBHOOK_URL)
// quand le bench est stable — sinon 120 messages/jour à V0-Lean full scope.

const slackHTTPTimeout = 5 * time.Second

// ProbeResult is what runSingleProbe returns. The cycle reporter
// aggregates them into the Slack post.
type ProbeResult struct {
	Service     Service
	Mode        string
	TipLamports uint64
	Signature   string // base58, empty if submission failed before sig
	Landed      bool
	SubmitSlot  uint64
	LandSlot    uint64
	SlotDelta   int64 // 0 if not landed or submitSlot unknown
	WallMs      int64
	DropReason  string // "timeout" | "invalid" | "network_error" | "rate_limited" | ""
	ErrorMsg    string // sanitized (scrubSecrets) — never includes API keys
}

type cycleSummary struct {
	CycleID         string
	Region          string
	Duration        time.Duration
	KeypairLamports uint64
	SubmitSlot      uint64
	Results         []ProbeResult
}

// postCycleToSlack builds a Block-Kit message and POSTs it. Non-blocking
// in the sense that errors are returned to the caller for logging, not
// re-thrown. The caller (runProbeCycle) swallows the error after logging.
// If webhookURL is empty, returns nil immediately.
func postCycleToSlack(ctx context.Context, webhookURL string, s cycleSummary) error {
	if webhookURL == "" {
		return nil
	}

	landed := 0
	for _, r := range s.Results {
		if r.Landed {
			landed++
		}
	}
	summary := fmt.Sprintf("cycle %s — %d/%d landed in %s",
		s.CycleID, landed, len(s.Results), s.Duration.Round(time.Millisecond))

	headerEmoji := "🛰️"
	if landed < len(s.Results) {
		headerEmoji = "⚠️"
	}
	if landed == 0 && len(s.Results) > 0 {
		headerEmoji = "🚨"
	}

	blocks := []map[string]interface{}{
		{
			"type": "header",
			"text": map[string]interface{}{
				"type": "plain_text",
				"text": fmt.Sprintf("%s OCB Solana TX Landing — cycle %s", headerEmoji, s.CycleID),
			},
		},
		{
			"type": "section",
			"text": map[string]interface{}{
				"type": "mrkdwn",
				"text": fmt.Sprintf(
					"*Region:* `%s`  •  *Landed:* %d/%d  •  *Duration:* %s\n*Balance:* %.6f SOL  •  *Submit slot:* %d",
					s.Region,
					landed, len(s.Results),
					s.Duration.Round(time.Millisecond),
					float64(s.KeypairLamports)/1e9,
					s.SubmitSlot,
				),
			},
		},
		{"type": "divider"},
	}

	for _, r := range s.Results {
		blocks = append(blocks, buildProbeBlock(r))
	}

	body := map[string]interface{}{
		"text":   "OCB Solana landing " + summary,
		"blocks": blocks,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal slack body: %w", err)
	}

	cctx, cancel := context.WithTimeout(ctx, slackHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, "POST", webhookURL, bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("new slack req: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("slack post: %s", scrubSecrets(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("slack http %d", resp.StatusCode)
	}
	return nil
}

// buildProbeBlock formats a single probe row as a Slack mrkdwn section.
func buildProbeBlock(r ProbeResult) map[string]interface{} {
	var line string
	if r.Landed {
		sigShort := r.Signature
		if len(sigShort) > 12 {
			sigShort = sigShort[:12] + "…"
		}
		line = fmt.Sprintf(
			"✅ *%s* `%s`  •  tip=%d lamports  •  %d ms / %d slots\n<https://explorer.solana.com/tx/%s|sig %s>",
			r.Service, r.Mode, r.TipLamports, r.WallMs, r.SlotDelta,
			r.Signature, sigShort,
		)
	} else {
		emoji := "❌"
		if r.DropReason == "timeout" {
			emoji = "⏱️"
		} else if r.DropReason == "rate_limited" {
			emoji = "🚦"
		} else if r.DropReason == "network_error" {
			emoji = "🌐"
		}
		detail := fmt.Sprintf("`%s`", r.DropReason)
		if r.ErrorMsg != "" {
			detail += " — " + truncate(scrubSecrets(r.ErrorMsg), 200)
		}
		line = fmt.Sprintf(
			"%s *%s* `%s`  •  tip=%d lamports  •  %s",
			emoji, r.Service, r.Mode, r.TipLamports, detail,
		)
	}
	return map[string]interface{}{
		"type": "section",
		"text": map[string]interface{}{
			"type": "mrkdwn",
			"text": line,
		},
	}
}
