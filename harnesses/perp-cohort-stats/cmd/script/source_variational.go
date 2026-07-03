package main

import (
	"fmt"
)

// VariationalNativeSource is a visibility-only stub. The public
// hostname `api.variational.io` fails to resolve (NXDOMAIN) as of
// Sprint 3, and Variational publishes no documented public REST
// alternative for cohort-level stats. The product is RFQ-style and
// most data sits behind authenticated GraphQL.
//
// DefiLlama tracks the venue under the slug "variational" with live
// total24h/total30d/openInterest values, so the router uses DefiLlama
// as the primary source. This stub exists so the per-venue health
// gauge has an honest "native = blocked" signal and the fetch-errors
// counter records the outage with error_type=public_api_blocked.
type VariationalNativeSource struct{}

func NewVariationalNativeSource() *VariationalNativeSource {
	return &VariationalNativeSource{}
}

func (s *VariationalNativeSource) Name() string { return srcVariationalNative }

func (s *VariationalNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "variational"
	perpCohortFetchErrors.WithLabelValues(venue, srcVariationalNative, "public_api_blocked").Inc()
	fmt.Printf("[perp-cohort][%s][%s] skipped: api.variational.io NXDOMAIN; see source_variational.go header\n",
		venue, srcVariationalNative)
	return res, nil
}
