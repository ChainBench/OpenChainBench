package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type WalletExplorerProvider struct{}

func NewWalletExplorerProvider() *WalletExplorerProvider { return &WalletExplorerProvider{} }

func (p *WalletExplorerProvider) Name() string                { return "walletexplorer" }
func (p *WalletExplorerProvider) Supports(chain string) bool  { return chain == "bitcoin" }

func (p *WalletExplorerProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) {
		return res
	}
	start := time.Now()
	u := "https://www.walletexplorer.com/api/1/address-lookup?caller=openchainbench&address=" + address
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
		Found    bool   `json:"found"`
		Label    string `json:"label"`
		WalletID string `json:"wallet_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if body.Found && !genericLabel(body.Label) {
		res.Label = body.Label
		res.HasLabel = true
		res.Raw = map[string]any{"label": body.Label, "wallet_id": body.WalletID}
	}
	return res
}
