package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// The cohort is built from three DefiLlama reads and one CoinGecko read.
//
//	/overview/fees   — one row per fee adapter, with 30d, prior 30d and 1y
//	/protocols       — the child protocols, some carrying a gecko_id
//	/config          — the 849 parent protocols, 451 with a gecko_id
//
// The third is the one that makes this possible. A fee adapter is per
// product (GMX V1 Perps, GMX V2 Perps, GMX Solana), and the token belongs
// to the parent, which has no row in /protocols at all. Without /config the
// join resolves 90 tokens; with it, 192. That is why bench 265's registry
// was twenty rows written by hand.
//
// Several adapters can resolve to one token. Those are one valuation with
// several fee streams (Uniswap V2 + V3 + V4), so the cohort is keyed by
// token and the fees are summed. Ranking them separately would price the
// same market cap three times.
const (
	llamaFees      = "https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"
	llamaProtocols = "https://api.llama.fi/protocols"
	llamaConfig    = "https://api.llama.fi/config"
	cgMarkets      = "https://api.coingecko.com/api/v3/coins/markets"
	userAgent      = "OCB-protocol-valuation/1.0 (+https://openchainbench.com)"
)

var httpClient = &http.Client{Timeout: 120 * time.Second}

type feeAdapter struct {
	Name           string  `json:"name"`
	DisplayName    string  `json:"displayName"`
	Category       string  `json:"category"`
	DefillamaID    string  `json:"defillamaId"`
	ParentProtocol string  `json:"parentProtocol"`
	Total30d       float64 `json:"total30d"`
	Total60dto30d  float64 `json:"total60dto30d"`
	Total1y        float64 `json:"total1y"`
}

type llamaProtocol struct {
	ID             any    `json:"id"`
	Name           string `json:"name"`
	Slug           string `json:"slug"`
	GeckoID        string `json:"gecko_id"`
	ParentProtocol string `json:"parentProtocol"`
}

type llamaParent struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	GeckoID string `json:"gecko_id"`
}

// Protocol is one row of the board: a token, the fee streams that accrue
// to it, and the category its peers sit in.
type Protocol struct {
	Slug     string // OCB slug, derived from the display name
	Name     string
	GeckoID  string
	Category string
	Via      string // "own" or "parent", published so the join is auditable
	Adapters []string
	Fees30d  float64
	Prev30d  float64
	Fees1y   float64
}

func getJSON(rawURL string, out any) error {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status_%d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// buildCohort joins the three DefiLlama reads into one row per token.
func buildCohort(minFees30d float64) ([]Protocol, cohortStats, error) {
	var feesResp struct {
		Protocols []feeAdapter `json:"protocols"`
	}
	if err := getJSON(llamaFees, &feesResp); err != nil {
		return nil, cohortStats{}, fmt.Errorf("fees: %w", err)
	}
	var protocols []llamaProtocol
	if err := getJSON(llamaProtocols, &protocols); err != nil {
		return nil, cohortStats{}, fmt.Errorf("protocols: %w", err)
	}
	var cfg struct {
		ParentProtocols []llamaParent `json:"parentProtocols"`
	}
	if err := getJSON(llamaConfig, &cfg); err != nil {
		return nil, cohortStats{}, fmt.Errorf("config: %w", err)
	}
	return joinCohort(feesResp.Protocols, protocols, cfg.ParentProtocols, minFees30d)
}

type cohortStats struct {
	Adapters, Mapped, Unmapped, ViaParent, Merged int
}

// joinCohort is the pure part, so the mapping is testable without the
// three network reads it normally needs.
func joinCohort(fees []feeAdapter, protocols []llamaProtocol, parents []llamaParent,
	minFees30d float64) ([]Protocol, cohortStats, error) {

	byID := map[string]llamaProtocol{}
	for _, p := range protocols {
		byID[idString(p.ID)] = p
	}
	byParent := map[string]llamaParent{}
	for _, p := range parents {
		byParent[p.ID] = p
	}

	var st cohortStats
	acc := map[string]*Protocol{}
	for _, f := range fees {
		if f.Total30d <= minFees30d {
			continue
		}
		st.Adapters++

		gecko, name, via := "", "", ""
		if p, ok := byID[idString(f.DefillamaID)]; ok {
			if p.GeckoID != "" {
				gecko, name, via = p.GeckoID, p.Name, "own"
			} else if par, ok := byParent[firstNonEmpty(p.ParentProtocol, f.ParentProtocol)]; ok && par.GeckoID != "" {
				gecko, name, via = par.GeckoID, par.Name, "parent"
			}
		}
		if gecko == "" {
			// No token, so no valuation. Most of the fee universe is here
			// and that is not a defect: a protocol can earn without having
			// something to value.
			st.Unmapped++
			continue
		}
		st.Mapped++

		e, seen := acc[gecko]
		if !seen {
			e = &Protocol{GeckoID: gecko, Name: name, Category: f.Category, Via: via}
			acc[gecko] = e
			if via == "parent" {
				st.ViaParent++
			}
		} else {
			st.Merged++
			// A parent name describes the whole token better than whichever
			// product happened to be read first ("Aave", not "Aave V2").
			if via == "parent" && e.Via != "parent" {
				e.Name, e.Via = name, "parent"
			}
		}
		e.Adapters = append(e.Adapters, firstNonEmpty(f.DisplayName, f.Name))
		e.Fees30d += f.Total30d
		e.Prev30d += f.Total60dto30d
		e.Fees1y += f.Total1y
	}

	out := make([]Protocol, 0, len(acc))
	for _, e := range acc {
		sort.Strings(e.Adapters)
		e.Slug = slugify(e.Name)
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Fees30d > out[j].Fees30d })
	return out, st, nil
}

// cgMarket is the slice of /coins/markets this harness uses.
type cgMarket struct {
	ID          string
	Mcap, FDV   float64
	Circ, Total float64
	PriceChg30d *float64
}

// fetchMarkets pages through CoinGecko 250 ids at a time. The free tier
// takes the whole cohort in one page today; the loop is there so a cohort
// that grows past 250 does not silently lose its tail.
func fetchMarkets(ids []string) (map[string]cgMarket, error) {
	out := map[string]cgMarket{}
	for i := 0; i < len(ids); i += 250 {
		end := i + 250
		if end > len(ids) {
			end = len(ids)
		}
		q := url.Values{}
		q.Set("vs_currency", "usd")
		q.Set("ids", strings.Join(ids[i:end], ","))
		q.Set("per_page", "250")
		q.Set("price_change_percentage", "30d")

		var page []struct {
			ID          string   `json:"id"`
			MarketCap   *float64 `json:"market_cap"`
			FDV         *float64 `json:"fully_diluted_valuation"`
			Circulating *float64 `json:"circulating_supply"`
			TotalSupply *float64 `json:"total_supply"`
			Chg30d      *float64 `json:"price_change_percentage_30d_in_currency"`
		}
		if err := getJSON(cgMarkets+"?"+q.Encode(), &page); err != nil {
			return out, fmt.Errorf("coingecko page %d: %w", i/250, err)
		}
		for _, c := range page {
			out[c.ID] = cgMarket{
				ID: c.ID, Mcap: deref(c.MarketCap), FDV: deref(c.FDV),
				Circ: deref(c.Circulating), Total: deref(c.TotalSupply),
				PriceChg30d: c.Chg30d,
			}
		}
	}
	return out, nil
}

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// idString normalises the defillamaId, which arrives as a JSON number on
// /protocols and as a string on /overview/fees.
func idString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return fmt.Sprintf("%.0f", t)
	case nil:
		return ""
	default:
		return fmt.Sprint(t)
	}
}

// slugify turns a display name into the label the site selects on. Kept
// deliberately dull: a label that changes when upstream re-punctuates a
// name breaks every stored query and every ranking history.
func slugify(name string) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteRune('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
