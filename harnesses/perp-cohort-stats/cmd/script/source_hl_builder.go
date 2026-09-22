package main

import (
	"encoding/json"
	"fmt"
)

// HLBuilderSource reads one Hyperliquid HIP-3 deployer dex as a venue
// of its own. trade.xyz operates the `xyz` dex (US and Asian equities,
// ETFs, metals, energy, FX and index perps settled on Hyperliquid's
// orderbook); its markets are not in the core Hyperliquid figures the
// hyperliquid row publishes (metaAndAssetCtxs without dex), so this row
// adds nothing twice.
//
//	POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs","dex":"xyz"}
//
// Derived metrics:
//
//	volume_24h_usd            = sum(dayNtlVlm)
//	oi_usd                    = sum(openInterest * markPx)
//	active_markets            = count(non-delisted universe entries)
//	top_market_volume_24h_usd = max(dayNtlVlm)
//
// Breadth goes through the router's cross-venue classification, the
// same path the hyperliquid row uses for its HIP-3 markets.
type HLBuilderSource struct {
	hl    *HyperliquidNativeSource
	venue string
	dex   string
	name  string
}

func NewHLBuilderSource(venue, dex, sourceName string) *HLBuilderSource {
	return &HLBuilderSource{hl: NewHyperliquidNativeSource(), venue: venue, dex: dex, name: sourceName}
}

func (s *HLBuilderSource) Name() string { return s.name }

func (s *HLBuilderSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	body, err := s.hl.post("https://api.hyperliquid.xyz/info", []byte(fmt.Sprintf(`{"type":"metaAndAssetCtxs","dex":%q}`, s.dex)))
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(s.venue, s.name, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", s.venue, s.name, err)
		return res, nil
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil || len(raw) != 2 {
		perpCohortFetchErrors.WithLabelValues(s.venue, s.name, "parse").Inc()
		return res, nil
	}
	var meta hlMeta
	var ctxs []hlCtx
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		perpCohortFetchErrors.WithLabelValues(s.venue, s.name, "parse").Inc()
		return res, nil
	}
	if err := json.Unmarshal(raw[1], &ctxs); err != nil {
		perpCohortFetchErrors.WithLabelValues(s.venue, s.name, "parse").Inc()
		return res, nil
	}
	var volSum, oiSum, topVol float64
	var active int
	var syms []string
	for i, c := range ctxs {
		if i >= len(meta.Universe) || meta.Universe[i].IsDelisted {
			continue
		}
		active++
		v := parseFloat(c.DayNtlVlm)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oiSum += parseFloat(c.OpenInterest) * parseFloat(c.MarkPx)
		syms = append(syms, baseSymbol(meta.Universe[i].Name))
	}
	if active == 0 {
		perpCohortFetchErrors.WithLabelValues(s.venue, s.name, "parse").Inc()
		return res, nil
	}
	res.SetIfPositive(s.venue, mVolume24h, volSum)
	res.SetIfPositive(s.venue, mOI, oiSum)
	res.SetIfPositive(s.venue, mActiveMarkets, float64(active))
	res.SetIfPositive(s.venue, mTopVol24h, topVol)
	res.SetUnclassified(s.venue, syms)
	fmt.Printf("[perp-cohort][%s][%s] ok: dex=%s active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		s.venue, s.name, s.dex, active, volSum, oiSum, topVol)
	return res, nil
}
