package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
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
	llamaRevenue   = llamaFees + "&dataType=dailyRevenue"
	llamaProtocols = "https://api.llama.fi/protocols"
	llamaConfig    = "https://api.llama.fi/config"
	cgAPI          = "https://api.coingecko.com/api/v3"
	cgMarkets      = cgAPI + "/coins/markets"
	userAgent      = "OCB-protocol-valuation/1.0 (+https://openchainbench.com)"
)

var httpClient = &http.Client{Timeout: 120 * time.Second}

var cgKey = os.Getenv("COINGECKO_API_KEY")

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
	ID             any     `json:"id"`
	Name           string  `json:"name"`
	Slug           string  `json:"slug"`
	GeckoID        string  `json:"gecko_id"`
	ParentProtocol string  `json:"parentProtocol"`
	TVL            float64 `json:"tvl"`
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
	// True when one of this token's adapters reports nothing over 30 days
	// after real fees over the year. The published total is then knowably
	// short of the protocol's revenue, so the ratio built on it is too.
	Incomplete bool
	// What the silent adapters earned over the past year, so the size of
	// the gap is visible rather than asserted.
	SilentFees1y float64

	// Revenue is the share of fees the protocol keeps, per each adapter's
	// own definition on DeFiLlama, summed over the same adapters as the
	// fees. Zero means DeFiLlama publishes no revenue series for any of
	// them, which is "unknown", not "keeps nothing": the P/S built on it
	// stays absent.
	Rev30d float64
	Rev1y  float64
	// Same rule as Incomplete, on the revenue series: a token is here when
	// its fee total is short (the silent product's revenue is missing by
	// the same amount) or when a revenue adapter reports nothing over 30
	// days after real revenue over the year.
	RevIncomplete bool

	// TVL summed over every /protocols row that resolves to this token,
	// own row or parent, so a lending protocol's V2, V3 and side markets
	// count once each. HasTVL is false when no row carries one: a perp
	// DEX on its own chain or a launchpad has nothing locked, and that is
	// not a zero.
	TVL    float64
	HasTVL bool
}

// A silent adapter is one reporting nothing this month after this much
// over the year. Below it, a dormant or retired product would flag a token
// whose fees really are what they say.
const silentAdapterYearUSD = 1_000_000

func getJSON(rawURL string, out any) error {
	_, err := getJSONStatus(rawURL, out)
	return err
}

// httpResult is what a caller needs to tell a rate limit from a broken
// read: the status, and the Retry-After CoinGecko sends with a 429.
type httpResult struct {
	status     int
	retryAfter time.Duration
}

func getJSONStatus(rawURL string, out any) (httpResult, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return httpResult{}, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	// A CoinGecko demo key (free, 30 calls a minute, 10k a month) lifts
	// the address-shared public limit. Optional: the harness runs without
	// one, only slower on the supply pass.
	if cgKey != "" && strings.HasPrefix(rawURL, cgAPI) {
		req.Header.Set("x-cg-demo-api-key", cgKey)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return httpResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	res := httpResult{status: resp.StatusCode}
	if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && secs > 0 {
		res.retryAfter = time.Duration(secs) * time.Second
	}
	if resp.StatusCode != http.StatusOK {
		return res, fmt.Errorf("status_%d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return res, err
	}
	return res, json.Unmarshal(body, out)
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
	// Revenue is the one read the board can do without: a failure here
	// leaves revenue and P/S absent for the tick rather than taking the
	// fees board down with it.
	var revResp struct {
		Protocols []feeAdapter `json:"protocols"`
	}
	if err := getJSON(llamaRevenue, &revResp); err != nil {
		pvFetchErrors.WithLabelValues("defillama_revenue").Inc()
		fmt.Printf("[cohort] revenue: %v (revenue and P/S absent this tick)\n", err)
		revResp.Protocols = nil
	}
	return joinCohort(feesResp.Protocols, revResp.Protocols, protocols, cfg.ParentProtocols, minFees30d)
}

type cohortStats struct {
	Adapters, Mapped, Unmapped, ViaParent, Merged int
	// Tokens with a silent adapter: published, but out of the ranking and
	// out of the medians.
	Incomplete int
	// Tokens dropped because their summed fees stayed under the floor.
	// Counted because the floor moved from the adapter to the token, and
	// the difference between those two rules is a cohort-size change a
	// reader should be able to see.
	BelowFloor int
}

// joinCohort is the pure part, so the mapping is testable without the
// four network reads it normally needs. revenue is the same overview read
// with dataType=dailyRevenue, one row per adapter keyed by defillamaId,
// and may be nil.
func joinCohort(fees, revenue []feeAdapter, protocols []llamaProtocol, parents []llamaParent,
	minFees30d float64) ([]Protocol, cohortStats, error) {

	byID := map[string]llamaProtocol{}
	for _, p := range protocols {
		byID[idString(p.ID)] = p
	}
	byParent := map[string]llamaParent{}
	for _, p := range parents {
		byParent[p.ID] = p
	}
	revByID := map[string]feeAdapter{}
	for _, r := range revenue {
		revByID[idString(r.DefillamaID)] = r
	}
	// TVL by token, over every /protocols row, resolved by the same rule
	// the fee adapters use: the row's own gecko_id first, else its
	// parent's. Rows without either belong to no token.
	tvlByToken := map[string]float64{}
	for _, p := range protocols {
		gecko := p.GeckoID
		if gecko == "" {
			gecko = byParent[p.ParentProtocol].GeckoID
		}
		if gecko != "" && p.TVL > 0 {
			tvlByToken[gecko] += p.TVL
		}
	}

	var st cohortStats
	acc := map[string]*Protocol{}
	// Category is decided per token after the loop, by fee weight, so an
	// adapter's own category is carried alongside its contribution.
	catWeight := map[string]map[string]float64{}

	for _, f := range fees {
		// The floor belongs on the token, not on the adapter. Applying it
		// here dropped every sub-floor product of a multi-product token out
		// of the sum, and excluded a token whose adapters only clear the
		// floor together — while the methodology said fees are summed
		// across every adapter that accrues to it.
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
			e = &Protocol{GeckoID: gecko, Name: name, Via: via}
			acc[gecko] = e
			catWeight[gecko] = map[string]float64{}
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
		catWeight[gecko][f.Category] += f.Total30d
		if f.Total30d == 0 && f.Total1y > silentAdapterYearUSD {
			e.Incomplete = true
			e.SilentFees1y += f.Total1y
		}
		// Revenue rides on the fee adapter: same product, same token, so
		// the sum spans exactly the adapters the fees do.
		if rv, ok := revByID[idString(f.DefillamaID)]; ok {
			e.Rev30d += rv.Total30d
			e.Rev1y += rv.Total1y
			if rv.Total30d == 0 && rv.Total1y > silentAdapterYearUSD {
				e.RevIncomplete = true
			}
		}
	}

	out := make([]Protocol, 0, len(acc))
	for gecko, e := range acc {
		// The token's category is the one its fees mostly come from, not
		// the one /overview/fees happened to list first. Taking the first
		// filed Drift under Liquid Staking and Sanctum under Dexs, which
		// is not cosmetic: the category median is the comparison the page
		// calls the column to read, and a mis-filed row both reads against
		// the wrong median and shifts the median its peers read against.
		e.Category = dominantCategory(catWeight[gecko])
		if e.Incomplete {
			st.Incomplete++
		}
		sort.Strings(e.Adapters)
		e.Slug = slugify(e.Name)
		if e.Incomplete {
			e.RevIncomplete = true
		}
		if tvl, ok := tvlByToken[gecko]; ok {
			e.TVL, e.HasTVL = tvl, true
		}
		if e.Fees30d <= minFees30d {
			st.BelowFloor++
			continue
		}
		out = append(out, *e)
	}
	st.Mapped = len(out)
	sort.Slice(out, func(i, j int) bool { return out[i].Fees30d > out[j].Fees30d })
	return out, st, nil
}

// dominantCategory is the category carrying the most of a token's fees.
// Ties break alphabetically so the label does not flip between polls on a
// token whose products are evenly matched.
func dominantCategory(weights map[string]float64) string {
	best, bestW := "", -1.0
	for cat, w := range weights {
		if w > bestW || (w == bestW && cat < best) {
			best, bestW = cat, w
		}
	}
	return best
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
		if err := getCoinGecko(cgMarkets+"?"+q.Encode(), &page); err != nil {
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
