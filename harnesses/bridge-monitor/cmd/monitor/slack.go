package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type SlackNotifier struct {
	webhookURL string
	client     *http.Client
	apiKey     string
	evmAddress string
	solAddress string
}

func NewSlackNotifier(webhookURL, apiKey, evmAddress, solAddress string) *SlackNotifier {
	if webhookURL == "" {
		return nil
	}
	return &SlackNotifier{
		webhookURL: webhookURL,
		client:     &http.Client{Timeout: 10 * time.Second},
		apiKey:     apiKey,
		evmAddress: evmAddress,
		solAddress: solAddress,
	}
}

type SlackMessage struct {
	Text   string       `json:"text,omitempty"`
	Blocks []SlackBlock `json:"blocks,omitempty"`
}

type SlackBlock struct {
	Type string     `json:"type"`
	Text *SlackText `json:"text,omitempty"`
}

type SlackText struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// NotifyBridgeExecution sends a Slack notification after a bridge execution
func (s *SlackNotifier) NotifyBridgeExecution(result *ExecutionResult) error {
	if s == nil {
		return nil
	}

	// Status emoji
	statusEmoji := "✅"
	statusText := "SUCCESS"
	if !result.Success {
		statusEmoji = "❌"
		statusText = "FAILED"
		if result.Reverted {
			statusEmoji = "🔄"
			statusText = "REVERTED"
		}
	}

	// Format latencies
	quoteLatency := fmt.Sprintf("%.0fms", float64(result.QuoteLatencyMs))
	execLatency := "N/A"
	e2eLatency := "N/A"
	if result.ExecutionLatencyMs > 0 {
		execLatency = fmt.Sprintf("%.1fs", float64(result.ExecutionLatencyMs)/1000)
	}
	if result.E2ELatencyMs > 0 {
		e2eLatency = fmt.Sprintf("%.1fs", float64(result.E2ELatencyMs)/1000)
	}

	// Get current balances
	balances := s.getBalanceSummary()

	// Error details (for failed executions, include raw JSON for debugging)
	errorSection := ""
	if !result.Success && result.Error != nil {
		errMsg := result.Error.Error()
		if len(errMsg) > 1500 {
			errMsg = errMsg[:1500] + "... (truncated)"
		}
		errorSection = fmt.Sprintf("\n*🔍 Error Details:*\n```%s```\n", errMsg)
	}

	// Build message
	message := fmt.Sprintf(`%s *Bridge Execution: %s*

*Route:* %s → %s
*Tokens:* %s → %s
*Amount:* $%.2f
*Bridge:* %s

*Latencies:*
• Quote: %s
• Execution: %s
• End-to-End: %s

*Costs:*
• Sent: $%.2f
• Filled: $%.4f
• Fees: $%.4f (%.2f%%)
• Total Cost: $%.4f

*TX:* %s
%s
━━━━━━━━━━━━━━━━━━━━━
%s`,
		statusEmoji,
		statusText,
		result.FromChain,
		result.ToChain,
		result.FromToken,
		result.ToToken,
		result.AmountUSD,
		result.Bridge,
		quoteLatency,
		execLatency,
		e2eLatency,
		result.AmountUSD,
		result.OutputUSD,
		result.FeesUSD,
		result.FeesPercent,
		result.CostUSD,
		result.TxHash,
		errorSection,
		balances,
	)

	return s.send(message)
}

// NotifyDailySummary sends a daily summary of all wallets
func (s *SlackNotifier) NotifyDailySummary() error {
	if s == nil {
		return nil
	}

	balances := s.getBalanceSummary()
	message := fmt.Sprintf("📊 *Daily Wallet Summary*\n\n%s", balances)
	return s.send(message)
}

// getBalanceSummary fetches and formats wallet balances
func (s *SlackNotifier) getBalanceSummary() string {
	var summary string

	// Fetch Solana balances
	solBalances := s.fetchBalances(s.solAddress, "solana")
	if solBalances != "" {
		summary += "*🟣 Solana Wallet:*\n" + solBalances + "\n"
	}

	// Fetch Base balances
	baseBalances := s.fetchBalances(s.evmAddress, "Base")
	if baseBalances != "" {
		summary += "*🔵 Base Wallet:*\n" + baseBalances + "\n"
	}

	// Fetch Arbitrum balances
	arbBalances := s.fetchBalances(s.evmAddress, "Arbitrum")
	if arbBalances != "" {
		summary += "*🟠 Arbitrum Wallet:*\n" + arbBalances
	}

	if summary == "" {
		summary = "_Could not fetch balances_"
	}

	return summary
}

// fetchBalances calls Mobula API to get wallet balances
func (s *SlackNotifier) fetchBalances(wallet, blockchain string) string {
	url := fmt.Sprintf("https://api.mobula.io/api/1/wallet/portfolio?wallet=%s&blockchains=%s", wallet, blockchain)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	var result struct {
		Data struct {
			Assets []struct {
				Asset struct {
					Symbol string `json:"symbol"`
				} `json:"asset"`
				TokenBalance     float64 `json:"token_balance"`
				EstimatedBalance float64 `json:"estimated_balance"`
			} `json:"assets"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return ""
	}

	var lines string
	for _, asset := range result.Data.Assets {
		if asset.EstimatedBalance > 0.01 {
			lines += fmt.Sprintf("• %s: %.4f ($%.2f)\n", asset.Asset.Symbol, asset.TokenBalance, asset.EstimatedBalance)
		}
	}

	return lines
}

// send posts a message to Slack
func (s *SlackNotifier) send(text string) error {
	msg := SlackMessage{Text: text}
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	resp, err := s.client.Post(s.webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack returned %d", resp.StatusCode)
	}

	return nil
}

// NotifyScheduledSkip notifies when a scheduled tier was not executed (e.g. insufficient
// funds on source chain, balance API down, daily spend limit reached). Fired from the
// executor so each tick produces at most one Slack per (route, amount, reason).
func (s *SlackNotifier) NotifyScheduledSkip(routeName, fromChain, fromToken string, amountUSD float64, reason string) error {
	if s == nil {
		return nil
	}
	balances := s.getBalanceSummary()
	message := fmt.Sprintf(`⏭️ *Scheduled Execution SKIPPED*

*Route:* %s
*Chain:* %s
*Token:* %s
*Amount:* $%.2f

*Reason:* %s

%s`,
		routeName, fromChain, fromToken, amountUSD, reason, balances,
	)
	return s.send(message)
}

// NotifyTierSkipped fires once per scheduler tick when a whole tier cycle cannot
// complete (pre-flight simulation failed). Replaces the per-route skip spam.
func (s *SlackNotifier) NotifyTierSkipped(tier float64, tierLabel, reason string) error {
	if s == nil {
		return nil
	}
	balances := s.getBalanceSummary()
	message := fmt.Sprintf(`⏭️ *Tier $%.0f (%s) — COULDN'T RUN*

*Reason:* %s

Waiting for next scheduled slot. Top up the blocked leg to unblock.

%s`,
		tier, tierLabel, reason, balances,
	)
	return s.send(message)
}

// NotifyRebalance reports every auto-rebalance event (attempted, succeeded,
// failed, capped) so the owner can audit what the self-healing loop moved.
func (s *SlackNotifier) NotifyRebalance(outcome, detail string) error {
	if s == nil {
		return nil
	}
	emoji := map[string]string{
		"attempted": "🔧",
		"succeeded": "✅",
		"failed":    "❌",
		"capped":    "🛑",
	}[outcome]
	if emoji == "" {
		emoji = "🔧"
	}
	message := fmt.Sprintf(`%s *Auto-Rebalance %s*

%s`, emoji, strings.ToUpper(outcome), detail)
	return s.send(message)
}

// NotifyTierDowngrade reports that a scheduled tier ran at a smaller amount
// because the requested size was not viable. Partial data beats none, but the
// owner should know the wallet needs attention.
func (s *SlackNotifier) NotifyTierDowngrade(from, to float64, reason string) error {
	if s == nil {
		return nil
	}
	message := fmt.Sprintf(`⬇️ *Tier DOWNGRADED: $%.0f to $%.0f*

*Reason $%.0f was blocked:* %s

Running the smaller tier so the benchmark keeps producing data.`,
		from, to, from, reason)
	return s.send(message)
}

// NotifyReaper reports stuck-fund reaper actions (corrective transfer of funds
// stranded off their home triangle leg).
func (s *SlackNotifier) NotifyReaper(detail string) error {
	if s == nil {
		return nil
	}
	message := fmt.Sprintf(`🧹 *Stuck-Fund Reaper*

%s`, detail)
	return s.send(message)
}

// NotifyGasTopUp reports gas top-up events (low native gas detected, swap
// attempted, succeeded, failed, capped or gated).
func (s *SlackNotifier) NotifyGasTopUp(chain, outcome, detail string) error {
	if s == nil {
		return nil
	}
	message := fmt.Sprintf(`⛽ *Gas Top-Up %s on %s*

%s`, strings.ToUpper(outcome), chain, detail)
	return s.send(message)
}

// NotifyStartup sends a startup notification
func (s *SlackNotifier) NotifyStartup(mode string) error {
	if s == nil {
		return nil
	}

	balances := s.getBalanceSummary()
	message := fmt.Sprintf(`🚀 *Bridge Benchmark Started*

*Mode:* %s
*Time:* %s

%s`,
		mode,
		time.Now().UTC().Format("2006-01-02 15:04:05 UTC"),
		balances,
	)

	return s.send(message)
}
