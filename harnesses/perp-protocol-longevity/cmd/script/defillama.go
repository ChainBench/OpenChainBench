package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type dlHack struct {
	Date           int64    `json:"date"`
	Name           string   `json:"name"`
	Classification string   `json:"classification"`
	Amount         float64  `json:"amount"`
	Source         string   `json:"source"`
	ReturnedFunds  *float64 `json:"returnedFunds"`
}

func fetchDefiLlamaHacks() ([]dlHack, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://api.llama.fi/hacks")
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d", resp.StatusCode)
	}
	var hacks []dlHack
	if err := json.Unmarshal(body, &hacks); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	return hacks, nil
}

// enrichFromDefiLlama fetches the DeFiLlama hacks feed and appends newly-discovered
// incidents into the registry. Rules per the bench methodology:
//   - Classification "Infrastructure" = front-end/phishing, skip
//   - Incident date before venue launch = skip (filters pre-launch false positives)
//   - Net-zero incidents (returnedFunds >= amount) = skip (no permanent loss)
//   - Already-recorded incidents (±48h match) = skip
func enrichFromDefiLlama(reg []venueRecord) []venueRecord {
	hacks, err := fetchDefiLlamaHacks()
	if err != nil {
		fmt.Printf("[LONGEVITY] DeFiLlama fetch failed: %v — using embedded registry\n", err)
		return reg
	}
	fmt.Printf("[LONGEVITY] DeFiLlama: fetched %d incidents\n", len(hacks))

	for i := range reg {
		if len(reg[i].DefiLlamaNames) == 0 {
			continue
		}
		for _, h := range hacks {
			if !dlMatchesVenue(h, reg[i].DefiLlamaNames) {
				continue
			}
			if h.Classification == "Infrastructure" {
				continue
			}
			t := time.Unix(h.Date, 0).UTC()
			if t.Before(reg[i].Launched) {
				continue
			}
			if h.Amount <= 0 {
				continue // null/zero amount = no confirmed financial loss
			}
			if h.ReturnedFunds != nil && *h.ReturnedFunds >= h.Amount {
				continue
			}
			if dlAlreadyRecorded(reg[i].Incidents, t) {
				continue
			}
			net := h.Amount
			if h.ReturnedFunds != nil {
				net -= *h.ReturnedFunds
			}
			src := h.Source
			if src == "" {
				src = "https://defillama.com/hacks"
			}
			reg[i].Incidents = append(reg[i].Incidents, incidentRecord{
				Date:      t,
				AmountUSD: net,
				Kind:      dlKind(h.Classification),
				Source:    src,
			})
			fmt.Printf("[LONGEVITY] DeFiLlama: +incident %s on %s ($%.0f net)\n",
				reg[i].Slug, t.Format("2006-01-02"), net)
		}
	}
	return reg
}

func dlMatchesVenue(h dlHack, names []string) bool {
	lower := strings.ToLower(h.Name)
	for _, n := range names {
		if strings.Contains(lower, strings.ToLower(n)) {
			return true
		}
	}
	return false
}

func dlAlreadyRecorded(incidents []incidentRecord, t time.Time) bool {
	for _, inc := range incidents {
		diff := inc.Date.Sub(t)
		if diff < 0 {
			diff = -diff
		}
		if diff < 48*time.Hour {
			return true
		}
	}
	return false
}

func dlKind(classification string) string {
	switch classification {
	case "Oracle":
		return "oracle-manipulation"
	case "Access Control":
		return "admin-key"
	default:
		return "exploit"
	}
}
