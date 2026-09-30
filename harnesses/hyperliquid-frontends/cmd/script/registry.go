package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Builder is one row of builders.json: a frontend and the on-chain builder
// address(es) it writes into the order's builder field.
type Builder struct {
	Slug      string   `json:"slug"`
	Name      string   `json:"name"`
	Address   string   `json:"address"`
	Addresses []string `json:"addresses,omitempty"`
	ValidFrom string   `json:"valid_from"`
	Notes     string   `json:"notes"`
}

// allAddresses returns every builder address attributed to this entry,
// lowercased and de-duplicated. `address` is the canonical one; `addresses`
// lists extra addresses for frontends that route through several.
func (b Builder) allAddresses() []string {
	seen := make(map[string]struct{}, 1+len(b.Addresses))
	out := make([]string, 0, 1+len(b.Addresses))
	add := func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	add(b.Address)
	for _, a := range b.Addresses {
		add(a)
	}
	return out
}

func loadBuilders(p string) ([]Builder, error) {
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var bs []Builder
	if err := json.Unmarshal(raw, &bs); err != nil {
		return nil, err
	}
	seenSlug := make(map[string]struct{}, len(bs))
	seenAddr := make(map[string]string, len(bs))
	for i := range bs {
		bs[i].Slug = strings.TrimSpace(bs[i].Slug)
		if bs[i].Slug == "" {
			return nil, fmt.Errorf("builders[%d]: empty slug", i)
		}
		if _, dup := seenSlug[bs[i].Slug]; dup {
			return nil, fmt.Errorf("builders: duplicate slug %q", bs[i].Slug)
		}
		seenSlug[bs[i].Slug] = struct{}{}
		addrs := bs[i].allAddresses()
		if len(addrs) == 0 {
			return nil, fmt.Errorf("builders[%s]: no address", bs[i].Slug)
		}
		for _, a := range addrs {
			if other, dup := seenAddr[a]; dup && other != bs[i].Slug {
				return nil, fmt.Errorf("builders: address %s listed under %q and %q", a, other, bs[i].Slug)
			}
			seenAddr[a] = bs[i].Slug
		}
	}
	return bs, nil
}
