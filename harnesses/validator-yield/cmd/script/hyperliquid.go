package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	hyperliquidChain = "hyperliquid"
	hlSourceTag      = "hyperliquid_info"
	hlPriceSourceTag = "hyperliquid_price"
)

// hlValidator mirrors the validatorSummaries response from
// api.hyperliquid.xyz/info. Verified shape (2026-05-21):
//
//   {
//     "validator": "0x…", "signer": "0x…", "name": "ValiDAO",
//     "nRecentBlocks": 2, "stake": 508149744592386,
//     "isJailed": false, "unjailableAfter": null, "isActive": true,
//     "commission": "0.04",
//     "stats": [
//       ["day",   {"uptimeFraction": "1.0", "predictedApr": "0.0215", "nSamples": 1440}],
//       ["week",  {...}],
//       ["month", {...}],
//     ]
//   }
//
// `stake` is in HYPE token-wei (weiDecimals=8), so divide by 1e8 to
// get HYPE units. `commission`, `uptimeFraction`, `predictedApr` are
// all stringified decimals.
type hlValidator struct {
	Validator       string           `json:"validator"`
	Signer          string           `json:"signer"`
	Name            string           `json:"name"`
	Description     string           `json:"description"`
	NRecentBlocks   int              `json:"nRecentBlocks"`
	IsJailed        bool             `json:"isJailed"`
	UnjailableAfter *int64           `json:"unjailableAfter"`
	IsActive        bool             `json:"isActive"`
	Stake           float64          `json:"stake"` // in HYPE-wei (1e8 wei per HYPE)
	Commission      string           `json:"commission"`
	Stats           []hlStatsEntry   `json:"stats"`
}

// hlStatsEntry is one row of the validatorSummaries `stats` array:
// `["day", {uptimeFraction: "1.0", predictedApr: "0.021", nSamples: 1440}]`.
type hlStatsEntry struct {
	Window string
	Data   hlStatsData
}

type hlStatsData struct {
	UptimeFraction json.Number `json:"uptimeFraction"`
	PredictedAPR   json.Number `json:"predictedApr"`
	NSamples       int64       `json:"nSamples"`
}

func (e *hlStatsEntry) UnmarshalJSON(b []byte) error {
	var pair []json.RawMessage
	if err := json.Unmarshal(b, &pair); err != nil {
		return err
	}
	if len(pair) < 2 {
		return fmt.Errorf("hl stats entry: expected 2 elements, got %d", len(pair))
	}
	if err := json.Unmarshal(pair[0], &e.Window); err != nil {
		return err
	}
	return json.Unmarshal(pair[1], &e.Data)
}

// pickStats returns the day stats by default, with fallback to week
// then month. Caller can rely on the returned data being usable as
// long as the validator had any stats at all.
func (v *hlValidator) pickStats() hlStatsData {
	prefer := []string{"day", "week", "month"}
	for _, w := range prefer {
		for _, e := range v.Stats {
			if e.Window == w {
				return e.Data
			}
		}
	}
	if len(v.Stats) > 0 {
		return v.Stats[0].Data
	}
	return hlStatsData{}
}

func hlPostInfo(ctx context.Context, client *http.Client, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hyperliqURL, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("hyperliquid http %d: %s", resp.StatusCode, string(raw))
	}
	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	return dec.Decode(out)
}

func fetchHyperliquidValidators(ctx context.Context, client *http.Client) ([]hlValidator, error) {
	var out []hlValidator
	err := hlPostInfo(ctx, client, map[string]any{"type": "validatorSummaries"}, &out)
	return out, err
}

// fetchHyperliquidHypePrice pulls the HYPE oracle price from the
// **perp** `metaAndAssetCtxs` endpoint. HYPE is listed as a perp (the
// spot-side canonical pair is PURR/USDC, not HYPE/USDC). Response is a
// tuple [meta, ctxs] where meta.universe[i].name aligns with ctxs[i].
// We grab oraclePx as the most stable signal, falling back to markPx
// then midPx.
func fetchHyperliquidHypePrice(ctx context.Context, client *http.Client) (float64, error) {
	var raw []json.RawMessage
	if err := hlPostInfo(ctx, client, map[string]any{"type": "metaAndAssetCtxs"}, &raw); err != nil {
		return 0, err
	}
	if len(raw) < 2 {
		return 0, fmt.Errorf("hyperliquid price: unexpected response length %d", len(raw))
	}

	var meta struct {
		Universe []struct {
			Name string `json:"name"`
		} `json:"universe"`
	}
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		return 0, fmt.Errorf("hyperliquid price meta parse: %w", err)
	}

	var ctxs []struct {
		MidPx    json.Number `json:"midPx"`
		MarkPx   json.Number `json:"markPx"`
		OraclePx json.Number `json:"oraclePx"`
	}
	if err := json.Unmarshal(raw[1], &ctxs); err != nil {
		return 0, fmt.Errorf("hyperliquid price ctxs parse: %w", err)
	}

	if len(meta.Universe) != len(ctxs) {
		return 0, fmt.Errorf("hyperliquid price: universe/ctxs length mismatch %d vs %d", len(meta.Universe), len(ctxs))
	}

	for i, u := range meta.Universe {
		if !strings.EqualFold(u.Name, "HYPE") {
			continue
		}
		c := ctxs[i]
		if v, err := c.OraclePx.Float64(); err == nil && v > 0 {
			return v, nil
		}
		if v, err := c.MarkPx.Float64(); err == nil && v > 0 {
			return v, nil
		}
		if v, err := c.MidPx.Float64(); err == nil && v > 0 {
			return v, nil
		}
	}
	return 0, fmt.Errorf("hyperliquid price: HYPE perp not found in universe (%d entries)", len(meta.Universe))
}

// hypeWeiPerToken is 10^weiDecimals for the HYPE token (8). validatorSummaries
// returns `stake` in HYPE-wei; divide by this to get HYPE units.
const hypeWeiPerToken = 1e8

func scrapeHyperliquid(ctx context.Context, client *http.Client) {
	vals, err := fetchHyperliquidValidators(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(hyperliquidChain, hlSourceTag).Inc()
		fmt.Printf("[hyperliquid] validatorSummaries err: %v\n", err)
		return
	}

	hypePrice, err := fetchHyperliquidHypePrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(hyperliquidChain, hlPriceSourceTag).Inc()
		fmt.Printf("[hyperliquid] price err (stake_usd will be 0): %v\n", err)
		hypePrice = 0
	}

	// We don't .Reset() here either — see solana.go for rationale.
	// HL validator set is small (~30) and stable, so stale labels
	// for de-listed validators are not a real cardinality concern.

	netYields := make([]float64, 0, len(vals))
	for _, v := range vals {
		name := shortenName(v.Name)
		id := v.Validator
		stats := v.pickStats()

		predictedAPR, _ := stats.PredictedAPR.Float64()
		// predictedApr is a decimal (0.0215 = 2.15%) → bps *10000.
		grossBps := pctToBps(predictedAPR)

		// Hyperliquid doesn't publish a MEV component to validators —
		// MEV is captured at the sequencer / book-building layer.
		mevBps := 0.0

		commissionDecimal := parseFloat(strings.TrimSpace(v.Commission))
		// commission is a decimal fraction (0.04 = 4%) → bps *10000.
		commissionBps := commissionDecimal * 10000
		if commissionBps > 10000 {
			commissionBps = 10000
		}

		uptimeFrac, _ := stats.UptimeFraction.Float64()
		uptimePct := uptimeFrac * 100
		if uptimePct > 100 {
			uptimePct = 100
		}
		if uptimePct < 0 {
			uptimePct = 0
		}

		netBps := grossBps * (uptimePct / 100)
		if v.IsJailed {
			netBps = 0
		}

		stakeUSD := (v.Stake / hypeWeiPerToken) * hypePrice

		jailed := 0.0
		if v.IsJailed {
			jailed = 1
		}

		validatorNetYieldBps.WithLabelValues(hyperliquidChain, id, name).Set(netBps)
		validatorGrossYieldBps.WithLabelValues(hyperliquidChain, id, name).Set(grossBps)
		validatorMevShareBps.WithLabelValues(hyperliquidChain, id, name).Set(mevBps)
		validatorCommissionBps.WithLabelValues(hyperliquidChain, id, name).Set(commissionBps)
		validatorUptimePct.WithLabelValues(hyperliquidChain, id, name).Set(uptimePct)
		validatorStakeUSD.WithLabelValues(hyperliquidChain, id, name).Set(stakeUSD)
		validatorJailed.WithLabelValues(hyperliquidChain, id, name).Set(jailed)

		netYields = append(netYields, netBps)
	}

	chainTotalValidators.WithLabelValues(hyperliquidChain).Set(float64(len(vals)))
	chainMedianNetYieldBps.WithLabelValues(hyperliquidChain).Set(medianBps(netYields))
	lastScrapeTimestamp.WithLabelValues(hyperliquidChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[hyperliquid] published %d validators, median net yield %.0f bps, HYPE=$%.4f\n",
		len(vals), medianBps(netYields), hypePrice)
}
