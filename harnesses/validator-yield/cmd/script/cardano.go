package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
)

// Cardano. Source: Koios public REST (api.koios.rest, no key).
//
// Network gross APR is MEASURED, not modelled: Koios epoch_info
// publishes, per completed epoch, the rewards actually paid to pools
// (operators + delegators) and the active stake they were paid on:
//
//	gross_apr = total_rewards(e) × epochs_per_year / active_stake(e)
//
// for the latest epoch whose rewards are computed (two epochs behind
// the tip), with epochs_per_year = 365.25 / 5. That figure already
// carries everything the protocol formula does (reserve depletion,
// fees, treasury cut τ, pledge influence a0, saturation k, block
// production luck), averaged over the whole network.
//
// Per pool: net = gross × (1 − margin), margin from Koios pool_list.
// The 340 ADA fixed cost per epoch is not subtracted (under 2% of a
// top-50 pool's epoch rewards). Cohort: the top 50 registered pools by
// active stake.
//
// History: until 2026-11 this file read `monetary_expansion` from
// epoch_params, a field Koios does not have (it is
// `monetary_expand_rate`), so it silently fell back to a hard-coded 5%
// network APR and the board showed ~4.9% median against a measured
// ~2.1%. It also only considered the first 1000 pools of an
// unordered, 1000-row page (Koios sorts active_stake as text).
// Verified 2026-11-03: epoch 663, 6.23M ADA rewards on 21.50B ADA
// active stake → 2.12% gross.

const (
	cardanoChain       = "cardano"
	koiosPoolListTag   = "koios_pool_list"
	koiosEpochInfoTag  = "koios_epoch_info"
	cardanoTopN        = 50
	lovelacePerAda     = 1e6
	cardanoEpochsPerYr = 365.25 / 5
	koiosPage          = 1000
)

var koiosBaseURL = envDefault("VAL_ECON_KOIOS_URL", "https://api.koios.rest/api/v1")

type koiosPoolListEntry struct {
	PoolIDBech32 string   `json:"pool_id_bech32"`
	Ticker       *string  `json:"ticker"`
	ActiveStake  *string  `json:"active_stake"` // lovelace
	Margin       *float64 `json:"margin"`
}

type koiosEpochInfo struct {
	EpochNo      int64   `json:"epoch_no"`
	ActiveStake  *string `json:"active_stake"`
	TotalRewards *string `json:"total_rewards"`
}

// cardanoGrossAPR picks the most recent epoch with computed rewards.
func cardanoGrossAPR(epochs []koiosEpochInfo) (float64, int64) {
	sort.Slice(epochs, func(i, j int) bool { return epochs[i].EpochNo > epochs[j].EpochNo })
	for _, e := range epochs {
		if e.TotalRewards == nil || e.ActiveStake == nil {
			continue
		}
		r, a := parseFloat(*e.TotalRewards), parseFloat(*e.ActiveStake)
		if r > 0 && a > 0 {
			return r * cardanoEpochsPerYr / a, e.EpochNo
		}
	}
	return 0, 0
}

func scrapeCardano(ctx context.Context, client *http.Client) {
	fail := func(tag string, err error) {
		scrapeErrorsTotal.WithLabelValues(cardanoChain, tag).Inc()
		fmt.Printf("[cardano] %s err: %v\n", tag, err)
	}
	var epochs []koiosEpochInfo
	if err := getJSON(ctx, client, koiosBaseURL+"/epoch_info?_include_next_epoch=false&order=epoch_no.desc&limit=6&select=epoch_no,active_stake,total_rewards", &epochs); err != nil {
		fail(koiosEpochInfoTag, err)
		return
	}
	apr, epoch := cardanoGrossAPR(epochs)
	if apr <= 0 || apr > 0.5 {
		fail(koiosEpochInfoTag, fmt.Errorf("no plausible epoch reward (apr %.4f)", apr))
		return
	}
	gross := pctToBps(apr)

	var pools []koiosPoolListEntry
	for offset := 0; offset < 20*koiosPage; offset += koiosPage {
		var page []koiosPoolListEntry
		url := fmt.Sprintf("%s/pool_list?pool_status=eq.registered&select=pool_id_bech32,ticker,active_stake,margin&offset=%d&limit=%d", koiosBaseURL, offset, koiosPage)
		if err := getJSON(ctx, client, url, &page); err != nil {
			fail(koiosPoolListTag, err)
			return
		}
		pools = append(pools, page...)
		if len(page) < koiosPage {
			break
		}
	}
	rows := make([]valRow, 0, len(pools))
	for _, p := range pools {
		if p.ActiveStake == nil || p.Margin == nil {
			continue
		}
		name := p.PoolIDBech32[:min(16, len(p.PoolIDBech32))]
		if p.Ticker != nil && *p.Ticker != "" {
			name = *p.Ticker
		}
		m := clamp(*p.Margin, 0, 1)
		rows = append(rows, valRow{
			ID: p.PoolIDBech32, Name: name,
			GrossBps: gross, NetBps: gross * (1 - m), CommissionBps: m * 10000, UptimePct: 100,
			StakeNative: parseFloat(*p.ActiveStake) / lovelacePerAda,
		})
	}
	rows = topNByStake(rows, cardanoTopN)
	if len(rows) == 0 {
		fail(koiosPoolListTag, fmt.Errorf("no pool with active stake"))
		return
	}
	med := publishRows(cardanoChain, rows, priceUSD(ctx, client, cardanoChain, "cardano"))
	fmt.Printf("[cardano] published %d pools (of %d registered), gross %.0f bps from epoch %d, median net %.0f bps\n",
		len(rows), len(pools), gross, epoch, med)
}
