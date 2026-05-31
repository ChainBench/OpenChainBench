package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Builder maps a curated frontend slug to its Hyperliquid builder-code
// EVM address. The address is what the on-chain `ApproveBuilderFee`
// action registers and what every order with that builder embedded
// surfaces in the per-day CSV dumps.
type Builder struct {
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Address   string `json:"address"`
	ValidFrom string `json:"valid_from"`
	Notes     string `json:"notes,omitempty"`
}

func loadRegistry(path string) ([]Builder, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var entries []Builder
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	for i := range entries {
		// Lowercase addresses — the Hyperliquid stats bucket is case
		// sensitive (paths only resolve when the address is lower).
		entries[i].Address = strings.ToLower(entries[i].Address)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("empty registry: %s", path)
	}
	return entries, nil
}
