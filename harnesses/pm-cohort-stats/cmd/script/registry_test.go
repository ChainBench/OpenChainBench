package main

import "testing"

// A venue in llamaNames with no registry row publishes nothing and says
// nothing: the fetch loop walks the Registry, so the mapping is dead
// weight nobody notices. The reverse is the state polymarket-us sat in
// until 2026-09-23 — a row on the board with no source behind it, which
// renders as a permanently empty line.
func TestEveryMappedVenueHasARegistryRow(t *testing.T) {
	inRegistry := map[string]bool{}
	for _, v := range Registry {
		inRegistry[v.Slug] = true
	}
	for slug := range llamaNames {
		if !inRegistry[slug] {
			t.Errorf("llamaNames maps %q, which is not in the Registry", slug)
		}
	}
}

// Every venue needs a source. A row fed neither by a dedicated fetcher nor
// by the aggregate is an empty line on the board, and the only way to tell
// is to look at the page.
func TestEveryVenueHasASource(t *testing.T) {
	// Venues with their own fetcher file, which the aggregate deliberately
	// skips so its authoritative gauges are not overwritten.
	native := map[string]bool{
		"polymarket": true, "kalshi": true, "myriad": true, "manifold": true,
	}
	for _, v := range Registry {
		if _, mapped := llamaNames[v.Slug]; !mapped && !native[v.Slug] {
			t.Errorf("%s (%s) has neither a native fetcher nor a DefiLlama name",
				v.Slug, v.Name)
		}
	}
}

func TestSlugsAreUniqueAndWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, v := range Registry {
		if seen[v.Slug] {
			t.Errorf("duplicate slug %q", v.Slug)
		}
		seen[v.Slug] = true
		if v.Slug == "" || v.Name == "" {
			t.Errorf("row with an empty slug or name: %+v", v)
		}
		for _, r := range v.Slug {
			ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
			if !ok {
				t.Errorf("slug %q has a character the Prom label cannot carry: %q", v.Slug, r)
			}
		}
		if v.Type != "onchain" && v.Type != "offchain" {
			t.Errorf("%s has type %q, want onchain or offchain", v.Slug, v.Type)
		}
	}
	if len(Registry) < 10 {
		t.Fatalf("registry is %d venues; the widening on 2026-09-23 took it to 17", len(Registry))
	}
}

// VenueBySlug is what the fetchers use to resolve a row; a nil return is a
// silently skipped venue.
func TestVenueBySlugFindsEveryRow(t *testing.T) {
	for _, v := range Registry {
		if got := VenueBySlug(v.Slug); got == nil || got.Slug != v.Slug {
			t.Errorf("VenueBySlug(%q) did not round-trip", v.Slug)
		}
	}
	if VenueBySlug("not-a-venue") != nil {
		t.Error("VenueBySlug returned a row for an unknown slug")
	}
}
