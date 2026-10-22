package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// GainsNativeSource derives Gains' trailing 24h trading volume
// from the stats backend's per-day volume mix, all chains summed.
//
// Endpoint (one call per UTC day):
//
//	GET https://backend-global.gains.trade/api/volume-mix?from=D&to=D
//
// The day's volume is autoVolumeUsd + directVolumeUsd: opens and closes
// at full notional, resizes at their traded delta. That is the trade
// perimeter of the Dune view DeFiLlama's adapter reads and the figure
// bench 266 (perp-daily-volume) stores per closed day, so the 24h gauge,
// the daily chart and defillama.com agree on what "Gains volume" means.
// Gains' own leveraged_volume counter is larger (resizes at full
// notional plus an "other" bucket, up to 3x on busy days) and is not
// used.
//
// Rolling 24h from day buckets: today so far plus the share of
// yesterday that is still inside the window, (24 - hours elapsed
// today) / 24. Exact at midnight, a linear approximation in between.
//
// History: v1 read https://stats.gains.trade/volume (rolling 24h). That
// host started answering Cloudflare 1016 on 2026-09-10 and the gauge
// froze at $44M for days. v2 used leveraged_volume deltas from
// /api/stats, which is the wrong perimeter (see above).
//
// Derived metrics:
//
//	volume_24h_usd = today(auto+direct) + yesterday(auto+direct) * (24 - h) / 24
//
// The market list and its asset classes come from the Arbitrum backend's
// trading variables (see gainsMarkets). Until 2026-10-12 they came from
// Mobula's perp pairs catalog, which Mobula deprecated (404 since then).
type GainsNativeSource struct {
	client *http.Client
	base   string
	tvURL  string
	// venue is the cohort slug the gauges carry. A gTrade deployment is
	// the same software at a different host, so one parser serves them.
	venue string
	// name is the source label on the error counters, kept per venue so a
	// fork failing does not look like Gains failing.
	name string
}

func NewGainsNativeSource() *GainsNativeSource {
	return &GainsNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
		base:   "https://backend-global.gains.trade",
		tvURL:  "https://backend-arbitrum.gains.trade/trading-variables",
		venue:  "gains",
		name:   srcGainsNative,
	}
}

// NewNovaNativeSource reads Nova, a gTrade deployment on Arbitrum. Its
// trading contract 0x1410FA3F87F6A6ea221E5D2aB608C23005eC34f3 has the same
// proxy bytecode as the Gains diamond, byte for byte, and its backend
// answers the same two endpoints with the same shape: verified 2026-10-22,
// volume-mix with autoVolumeUsd and directVolumeUsd, trading-variables with
// 493 pairs and the same pairOis structure.
func NewNovaNativeSource() *GainsNativeSource {
	return &GainsNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
		base:   "https://backend-global.nova.markets",
		tvURL:  "https://backend-arbitrum.nova.markets/trading-variables",
		venue:  "nova",
		name:   srcNovaNative,
	}
}

func (s *GainsNativeSource) Name() string { return s.name }

type gainsVolumeMix struct {
	AutoVolumeUsd   float64 `json:"autoVolumeUsd"`
	DirectVolumeUsd float64 `json:"directVolumeUsd"`
	TotalVolumeUsd  float64 `json:"totalVolumeUsd"`
	LastTradeTS     int64   `json:"lastTradeTimestamp"`
}

func (m gainsVolumeMix) perp() float64 { return m.AutoVolumeUsd + m.DirectVolumeUsd }

// gainsVolume24hFromDays blends today's partial day and yesterday's full
// day into a trailing 24h figure. yesterdayOK is false when yesterday
// could not be read; today alone is then returned only in the last
// hours of the day, otherwise 0 (unknown), so the gauge keeps its last
// value instead of publishing a fraction of a day.
func gainsVolume24hFromDays(today, yesterday float64, yesterdayOK bool, now time.Time) float64 {
	h := now.Sub(now.Truncate(24 * time.Hour)).Hours()
	if h < 0 || h > 24 {
		return 0
	}
	if !yesterdayOK {
		if h >= 20 {
			return today
		}
		return 0
	}
	v := today + yesterday*(24-h)/24
	if v < 0 {
		return 0
	}
	return v
}

func (s *GainsNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := s.venue
	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")

	s.markets(res, venue)

	mixToday, err := s.volumeMix(today)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] day=%s err: %v\n", venue, s.name, today, err)
		return res, nil
	}
	mixYesterday, errY := s.volumeMix(yesterday)
	if errY != nil {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, classifyError(errY.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] day=%s err: %v\n", venue, s.name, yesterday, errY)
	}

	v := gainsVolume24hFromDays(mixToday.perp(), mixYesterday.perp(), errY == nil, now)
	if v > 0 {
		res.SetIfPositive(venue, mVolume24h, v)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f (today=%.0f yesterday=%.0f, total-perimeter today=%.0f)\n",
			venue, s.name, v, mixToday.perp(), mixYesterday.perp(), mixToday.TotalVolumeUsd)
	}
	return res, nil
}

type gainsTradingVariables struct {
	Pairs []struct {
		From       string `json:"from"`
		To         string `json:"to"`
		GroupIndex string `json:"groupIndex"`
	} `json:"pairs"`
	Groups []struct {
		Name string `json:"name"`
	} `json:"groups"`
	PairInfos struct {
		// Per-pair max leverage override, 1e3 precision; 0 means the
		// group's maximum applies.
		MaxLeverages []json.Number `json:"maxLeverages"`
	} `json:"pairInfos"`
	// One entry per collateral the deployment accepts, each carrying the
	// per-pair open interest in that collateral's own units.
	Collaterals []struct {
		Symbol string `json:"symbol"`
		Config struct {
			Decimals int `json:"decimals"`
		} `json:"collateralConfig"`
		Prices struct {
			CollateralPriceUsd float64 `json:"collateralPriceUsd"`
		} `json:"prices"`
		PairOis []struct {
			Collateral struct {
				Long  json.Number `json:"oiLongCollateral"`
				Short json.Number `json:"oiShortCollateral"`
			} `json:"collateral"`
		} `json:"pairOis"`
	} `json:"collaterals"`
}

// gainsOpenInterestUSD sums long plus short across every pair and every
// collateral, each converted with its own decimals and USD price. An OI
// held in WETH or GNS counted at face value would misstate the venue, which
// is the same reasoning the perp-liq-rate harness documents for its read.
//
// ok is false when a collateral declares no decimals or no price: a zero
// there silently divides the venue's OI to nothing, and publishing that is
// worse than publishing none.
func gainsOpenInterestUSD(tv gainsTradingVariables) (total float64, ok bool) {
	if len(tv.Collaterals) == 0 {
		return 0, false
	}
	for _, c := range tv.Collaterals {
		if c.Config.Decimals <= 0 || c.Prices.CollateralPriceUsd <= 0 {
			return 0, false
		}
		scale := math.Pow(10, float64(c.Config.Decimals))
		for _, po := range c.PairOis {
			long, errL := po.Collateral.Long.Float64()
			short, errS := po.Collateral.Short.Float64()
			if errL != nil || errS != nil {
				continue
			}
			total += (long + short) / scale * c.Prices.CollateralPriceUsd
		}
	}
	return total, true
}

// gainsGroupClass maps a Gains pair group to a breadth class. The groups
// are the venue's own taxonomy (crypto, altcoins, crypto-degen, forex,
// forex-minor, forex-exotic, stocks-1..3, indices, commodities-1..2);
// ok is false for a group this table has never seen.
func gainsGroupClass(group string) (string, bool) {
	switch {
	// hype-1000 is a Nova group holding one pair, HYPE1000/USD, which is
	// HYPE at the 1000x tier. Without it Nova's whole breadth read is
	// withheld for one unknown group (see the unknown-group guard in
	// markets()), which is the right default and the wrong outcome here.
	case group == "crypto", group == "altcoins", group == "crypto-degen",
		group == "hype-1000":
		return classCrypto, true
	case strings.HasPrefix(group, "forex"):
		return classForex, true
	case strings.HasPrefix(group, "stocks"):
		return classStocks, true
	case group == "indices":
		return classIndices, true
	case strings.HasPrefix(group, "commodities"):
		return classCommodities, true
	}
	return "", false
}

// gainsMarket is one listed pair after the delisting filter.
type gainsMarket struct {
	base  string // the non-USD leg, upper-cased
	class string
}

// gainsMarkets returns the pairs a trader can open. Gains never removes a
// pair from the array; it delists one by setting its max leverage
// override to 1, which is 0.001x at the 1e3 precision (MATIC, LUNA, FTT,
// FB carry it). Everything else, a 0 override (group maximum) or a real
// one (2x, 5x on the stocks), is tradable. unknown lists the group names
// the class table does not cover; the caller must not publish a breadth
// split with a hole in it.
func gainsMarkets(tv gainsTradingVariables) (markets []gainsMarket, unknown []string) {
	seen := map[string]bool{}
	for i, p := range tv.Pairs {
		if i < len(tv.PairInfos.MaxLeverages) {
			if lev, err := tv.PairInfos.MaxLeverages[i].Int64(); err == nil && lev > 0 && lev < 1000 {
				continue
			}
		}
		gi, err := strconv.Atoi(p.GroupIndex)
		if err != nil || gi < 0 || gi >= len(tv.Groups) {
			unknown = append(unknown, "group#"+p.GroupIndex)
			continue
		}
		class, ok := gainsGroupClass(tv.Groups[gi].Name)
		if !ok {
			if !seen[tv.Groups[gi].Name] {
				seen[tv.Groups[gi].Name] = true
				unknown = append(unknown, tv.Groups[gi].Name)
			}
			continue
		}
		base := strings.ToUpper(p.From)
		if base == "USD" && p.To != "" {
			base = strings.ToUpper(p.To) // USD/JPY is a yen market
		}
		markets = append(markets, gainsMarket{base: base, class: class})
	}
	return markets, unknown
}

// markets publishes active_markets and the asset-class split from the
// trading variables, and seeds the cohort's crypto and RWA symbol sets
// that classify the HIP-3 dexes (breadth.go).
func (s *GainsNativeSource) markets(res *SourceResult, venue string) {
	body, err := s.get(s.tvURL)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err trading-variables: %v\n", venue, s.name, err)
		return
	}
	var tv gainsTradingVariables
	if err := json.Unmarshal(body, &tv); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse trading-variables: %v\n", venue, s.name, err)
		return
	}
	markets, unknown := gainsMarkets(tv)
	res.SetIfPositive(venue, mActiveMarkets, float64(len(markets)+len(unknown)))
	if oi, ok := gainsOpenInterestUSD(tv); ok {
		res.SetIfPositive(venue, mOI, oi)
		fmt.Printf("[perp-cohort][%s][%s] ok trading-variables: oi=%.0f usd\n", venue, s.name, oi)
	}
	b := breadthCounter{}
	for _, m := range markets {
		b.add(m.class)
		if m.class == classCrypto {
			res.AddCryptoSymbol(m.base)
		} else {
			res.AddRWASymbol(m.base)
		}
	}
	if len(unknown) > 0 {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, "unknown_group").Inc()
		fmt.Printf("[perp-cohort][%s][%s] breadth withheld, unknown groups: %v\n", venue, s.name, unknown)
	} else {
		res.SetBreadth(venue, b)
	}
	fmt.Printf("[perp-cohort][%s][%s] ok trading-variables: pairs=%d active=%d breadth: %s\n",
		venue, s.name, len(tv.Pairs), len(markets), b)
}

func (s *GainsNativeSource) volumeMix(day string) (gainsVolumeMix, error) {
	var mix gainsVolumeMix
	body, err := s.get(fmt.Sprintf("%s/api/volume-mix?from=%s&to=%s", s.base, day, day))
	if err != nil {
		return mix, err
	}
	if err := json.Unmarshal(body, &mix); err != nil {
		return mix, fmt.Errorf("parse: %w", err)
	}
	return mix, nil
}

func (s *GainsNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}
