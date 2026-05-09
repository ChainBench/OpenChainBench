package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type XRPScanProvider struct{}

func NewXRPScanProvider() *XRPScanProvider { return &XRPScanProvider{} }

func (p *XRPScanProvider) Name() string                { return "xrpscan" }
func (p *XRPScanProvider) Supports(chain string) bool  { return chain == "xrp" }

func (p *XRPScanProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) {
		return res
	}
	start := time.Now()
	u := "https://api.xrpscan.com/api/v1/account/" + address
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	resp, err := httpClient.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Err = err
		return res
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		res.Err = fmt.Errorf("status_%d", resp.StatusCode)
		return res
	}
	var body struct {
		AccountName *struct {
			Name     string `json:"name"`
			Domain   string `json:"domain"`
			Verified bool   `json:"verified"`
		} `json:"accountName"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if body.AccountName != nil && !genericLabel(body.AccountName.Name) {
		res.Label = body.AccountName.Name
		res.HasLabel = true
		res.Raw = map[string]any{
			"name":     body.AccountName.Name,
			"domain":   body.AccountName.Domain,
			"verified": body.AccountName.Verified,
		}
	}
	return res
}
