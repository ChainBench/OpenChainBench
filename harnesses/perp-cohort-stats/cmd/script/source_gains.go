package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
type GainsNativeSource struct {
	client *http.Client
	base   string
}

func NewGainsNativeSource() *GainsNativeSource {
	return &GainsNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
		base:   "https://backend-global.gains.trade",
	}
}

func (s *GainsNativeSource) Name() string { return srcGainsNative }

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
	venue := "gains"
	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")

	mixToday, err := s.volumeMix(today)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] day=%s err: %v\n", venue, srcGainsNative, today, err)
		return res, nil
	}
	mixYesterday, errY := s.volumeMix(yesterday)
	if errY != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, classifyError(errY.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] day=%s err: %v\n", venue, srcGainsNative, yesterday, errY)
	}

	v := gainsVolume24hFromDays(mixToday.perp(), mixYesterday.perp(), errY == nil, now)
	if v > 0 {
		res.SetIfPositive(venue, mVolume24h, v)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f (today=%.0f yesterday=%.0f, total-perimeter today=%.0f)\n",
			venue, srcGainsNative, v, mixToday.perp(), mixYesterday.perp(), mixToday.TotalVolumeUsd)
	}
	return res, nil
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
