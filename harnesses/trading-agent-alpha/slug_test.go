package main

import (
	"os"
	"regexp"
	"testing"
)

// The site builds a bench's metric-panel queries as
// `<metric>{agent="<provider slug>"}` from the YAML, with no way for a spec to
// declare that the label holds something else. So every name the harness
// publishes has to slugify to a slug the spec declares, or that panel renders
// blank for that row. It shipped blank once: the harness published the agent's
// NAME, the five panel-backed ledger columns matched nothing, and the bench
// audit passed anyway because it only ever checked the headline alpha.
//
// This test reads the slugs out of the spec rather than restating them, so a
// renamed provider fails here instead of silently emptying a column.
func TestSlugOfMatchesSpec(t *testing.T) {
	names := []string{
		"gemini 3 pro chart",
		"grok 4 chart",
		"grok 4 vision",
		"opus 4.5 chart",
		"gpt-5.2 chart",
		"gemini 3 pro vision",
		"sonnet 4.5 vision",
		"gpt-5.2 vision",
	}

	spec, err := os.ReadFile("../../benchmarks/trading-agent-alpha.yml")
	if err != nil {
		t.Skipf("spec not readable from here: %v", err)
	}
	declared := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s+- slug: (\S+)`).FindAllSubmatch(spec, -1) {
		declared[string(m[1])] = true
	}
	if len(declared) != len(names) {
		t.Fatalf("spec declares %d providers, the roster has %d", len(declared), len(names))
	}

	for _, n := range names {
		got := slugOf(n)
		if !declared[got] {
			t.Errorf("slugOf(%q) = %q, which the spec does not declare", n, got)
		}
	}
}

func TestSlugOfShape(t *testing.T) {
	cases := map[string]string{
		"opus 4.5 chart":  "opus-45-chart", // a dot joins, never separates
		"gpt-5.2 vision":  "gpt-52-vision", // an existing dash survives
		"grok 4 chart":    "grok-4-chart",
		"  padded  name ": "padded-name", // no leading or trailing dash
	}
	for in, want := range cases {
		if got := slugOf(in); got != want {
			t.Errorf("slugOf(%q) = %q, want %q", in, got, want)
		}
	}
}
