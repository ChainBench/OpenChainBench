package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Poller hits Mobula's wallet portfolio endpoint to fetch the Relay
// solver EOA's full balance in USD, across every chain Mobula indexes.
// Each successful poll appends a (timestamp, total_usd) snapshot to the
// rolling window so we can compute net balance delta over 24h/7d/30d.
//
// Balance delta = retained margin captured by the solver = the FLOOR on
// Relay's protocol revenue. Inflows alone would measure gross swap
// throughput (the wallet receives the full deposit then forwards almost
// all of it to the user on destination chain), so tracking the balance
// itself is the right proxy.
//
// Cadence: every PollIntervalSec (default 300s). The /wallet/portfolio
// endpoint takes 5-15s to resolve for a multi-chain wallet of this
// size, so we keep the HTTP timeout generous.
type Poller struct {
	apiKey  string
	wallet  string
	window  *Window
	cfg     *Config
	client  *http.Client
}

func NewPoller(cfg *Config, window *Window) *Poller {
	return &Poller{
		apiKey: cfg.MobulaAPIKey,
		wallet: RelaySolver,
		window: window,
		cfg:    cfg,
		client: &http.Client{Timeout: 90 * time.Second},
	}
}

// Run loops forever, polling the portfolio at PollIntervalSec cadence.
func (p *Poller) Run(ctx context.Context) {
	// First poll fires immediately so the harness has a baseline snapshot
	// instead of waiting one cadence period.
	p.tick(ctx)
	ticker := time.NewTicker(time.Duration(p.cfg.PollIntervalSec) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.tick(ctx)
		}
	}
}

func (p *Poller) tick(ctx context.Context) {
	t0 := time.Now()
	total, stable, assets, err := p.fetch(ctx)
	if err != nil {
		fmt.Printf("[poller] portfolio fetch error: %v\n", err)
		pollErrors.Inc()
		return
	}
	elapsed := time.Since(t0)
	balanceUSD.WithLabelValues("total").Set(total)
	balanceUSD.WithLabelValues("stables").Set(stable)
	assetsCount.Set(float64(assets))
	pollDurationSec.Set(elapsed.Seconds())
	pollSuccess.Inc()
	p.window.Add(time.Now(), total, stable)
	fmt.Printf("[poller] balance=$%.0f stables=$%.0f assets=%d (took %.1fs)\n",
		total, stable, assets, elapsed.Seconds())
}

// fetch hits the Mobula portfolio endpoint and extracts:
// - total_wallet_balance: cross-chain total in USD
// - stablecoin sub-balance (USDC + USDT + DAI + FRAX + USDE + FDUSD + ...)
// - assets count (diagnostic)
//
// Stablecoin sub-balance is the most defensible "margin captured" signal
// because it strips the price-volatility noise. If ETH price moves 5%
// the total balance moves a lot but the margin is unchanged; stable
// balance change is purely flow.
func (p *Poller) fetch(ctx context.Context) (float64, float64, int, error) {
	endpoint := "https://api.mobula.io/api/1/wallet/portfolio?wallet=" + p.wallet
	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", p.apiKey)
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return 0, 0, 0, fmt.Errorf("http %d: %s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	var r struct {
		Data struct {
			TotalWalletBalance float64 `json:"total_wallet_balance"`
			Assets             []struct {
				Asset struct {
					Symbol string `json:"symbol"`
				} `json:"asset"`
				EstimatedBalance float64 `json:"estimated_balance"`
			} `json:"assets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return 0, 0, 0, fmt.Errorf("parse: %v", err)
	}
	stable := 0.0
	for _, a := range r.Data.Assets {
		sym := a.Asset.Symbol
		if isStable(sym) {
			stable += a.EstimatedBalance
		}
	}
	return r.Data.TotalWalletBalance, stable, len(r.Data.Assets), nil
}

// isStable returns true for symbols we treat as USD-pegged. List is
// intentionally narrow — only the major stablecoins so price-volatility
// noise stays low in the "stables" balance delta.
func isStable(symbol string) bool {
	switch symbol {
	case "USDC", "USDT", "DAI", "FRAX", "USDE", "FDUSD", "PYUSD", "TUSD",
		"USDD", "GUSD", "LUSD", "MIM", "USDP", "BUSD", "EUROC", "EURC",
		"USDS", "RLUSD":
		return true
	}
	return false
}
