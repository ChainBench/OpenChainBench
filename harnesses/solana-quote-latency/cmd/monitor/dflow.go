package main

import (
	"context"
	"fmt"
)

// DFlowProvider — STUB.
// TODO: implement based on agent-1's curl validation. DFlow's quote endpoint
// and auth shape must be captured first, then ported following Jupiter as a
// template.
type DFlowProvider struct {
	region string
	apiKey string
}

func NewDFlowProvider(region, apiKey string) *DFlowProvider {
	return &DFlowProvider{region: region, apiKey: apiKey}
}

func (p *DFlowProvider) Slug() string { return "dflow" }

func (p *DFlowProvider) Probe(ctx context.Context, tokenOut TrendingToken) (int64, bool, error) {
	// TODO: implement based on agent-1's curl validation
	RecordOtherError(p.Slug(), p.region, "not_implemented")
	return 0, false, fmt.Errorf("dflow provider not implemented")
}
