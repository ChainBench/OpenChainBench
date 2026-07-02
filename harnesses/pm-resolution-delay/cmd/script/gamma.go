package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Gamma API client. Two jobs:
//  1. categoryLoop: crawl recently-closed events (which embed both tags and
//     markets) to map questionID -> category. Tags only exist on the /events
//     endpoint; /markets returns category=null (verified live 2026-06-12).
//  2. pendingLoop: count markets past their scheduled endDate that are still
//     open and unresolved (the markets users are waiting on right now).
//
// Gamma's closedTime is written AT resolution (== QuestionResolved block
// timestamp, verified live), so it is never used as a delay anchor here.

type gammaTag struct {
	Slug  string `json:"slug"`
	Label string `json:"label"`
}

type gammaMarket struct {
	QuestionID          string `json:"questionID"`
	ConditionID         string `json:"conditionId"`
	Question            string `json:"question"`
	EndDate             string `json:"endDate"`
	Closed              bool   `json:"closed"`
	UmaResolutionStatus string `json:"umaResolutionStatus"`
	Events              []struct {
		Title string `json:"title"`
		Slug  string `json:"slug"`
	} `json:"events"`
}

type gammaEvent struct {
	Tags    []gammaTag    `json:"tags"`
	Markets []gammaMarket `json:"markets"`
}

type gammaStore struct {
	http *http.Client

	mu    sync.Mutex
	byQID map[string]string // questionID -> category
}

func newGammaStore() *gammaStore {
	return &gammaStore{
		http:  &http.Client{Timeout: 30 * time.Second},
		byQID: map[string]string{},
	}
}

func (g *gammaStore) category(qid string) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	cat, ok := g.byQID[strings.ToLower(qid)]
	return cat, ok
}

func (g *gammaStore) get(ctx context.Context, path string, params url.Values, out any) error {
	u := gammaBase + path + "?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gamma %s: http %d: %.120s", path, resp.StatusCode, raw)
	}
	return json.Unmarshal(raw, out)
}

// crawlCategories pages recently-closed events (newest closedTime first) and
// records questionID -> category. Offset pagination is deprecated on Gamma
// but still honored for the shallow pages we use (<=2000 rows); the keyword
// fallback on ancillary titles covers anything we miss.
func (g *gammaStore) crawlCategories(ctx context.Context, pages int) {
	added := 0
	for page := 0; page < pages && ctx.Err() == nil; page++ {
		params := url.Values{}
		params.Set("closed", "true")
		params.Set("order", "closedTime")
		params.Set("ascending", "false")
		params.Set("limit", "100")
		params.Set("offset", fmt.Sprintf("%d", page*100))
		var events []gammaEvent
		if err := g.get(ctx, "/events", params, &events); err != nil {
			log.Printf("[gamma] category crawl page %d failed: %v", page, err)
			return
		}
		if len(events) == 0 {
			break
		}
		g.mu.Lock()
		if len(g.byQID) > 200000 { // bound memory over months
			g.byQID = map[string]string{}
		}
		for _, e := range events {
			cat := classifyTags(e.Tags)
			for _, m := range e.Markets {
				if m.QuestionID == "" {
					continue
				}
				g.byQID[strings.ToLower(m.QuestionID)] = cat
				added++
			}
		}
		g.mu.Unlock()
	}
	log.Printf("[gamma] category crawl done: %d question->category mappings stored", g.size())
	_ = added
}

func (g *gammaStore) size() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.byQID)
}

// categoryLoop keeps the freshest closed-event pages warm. The deep startup
// crawl happens in main before the chain backfill starts.
func (g *gammaStore) categoryLoop(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.crawlCategories(ctx, 3)
		}
	}
}

// refreshPending counts open (closed=false) markets whose scheduled endDate
// already passed, looking back 30 days. Keyset pagination on endDate
// descending (offset-free): each page moves end_date_max to the smallest
// endDate seen minus one second.
func (g *gammaStore) refreshPending(ctx context.Context) {
	now := time.Now().UTC()
	minDate := now.Add(-30 * 24 * time.Hour)
	cursor := now
	counts := map[string]int{"sports": 0, "politics": 0, "crypto": 0, "other": 0}
	var oldest time.Time
	seen := map[string]bool{}

	for page := 0; page < 40 && ctx.Err() == nil; page++ {
		params := url.Values{}
		params.Set("closed", "false")
		params.Set("order", "endDate")
		params.Set("ascending", "false")
		params.Set("limit", "100")
		params.Set("end_date_min", minDate.Format(time.RFC3339))
		params.Set("end_date_max", cursor.Format(time.RFC3339))
		var markets []gammaMarket
		if err := g.get(ctx, "/markets", params, &markets); err != nil {
			log.Printf("[gamma] pending crawl failed: %v (keeping previous gauges)", err)
			return
		}
		if len(markets) == 0 {
			break
		}
		var pageMin time.Time
		for _, m := range markets {
			ed, err := time.Parse(time.RFC3339, m.EndDate)
			if err != nil {
				log.Printf("[gamma] unparseable endDate %q on %q, skipping", m.EndDate, m.Question)
				continue
			}
			if pageMin.IsZero() || ed.Before(pageMin) {
				pageMin = ed
			}
			key := m.QuestionID
			if key == "" {
				key = m.ConditionID
			}
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			if strings.EqualFold(m.UmaResolutionStatus, "resolved") {
				continue
			}
			var texts strings.Builder
			texts.WriteString(m.Question)
			for _, ev := range m.Events {
				texts.WriteString(" ")
				texts.WriteString(ev.Title)
				texts.WriteString(" ")
				texts.WriteString(ev.Slug)
			}
			if c, ok := g.category(m.QuestionID); ok {
				counts[c]++
			} else {
				counts[classifyText(texts.String())]++
			}
			if oldest.IsZero() || ed.Before(oldest) {
				oldest = ed
			}
		}
		if pageMin.IsZero() || !pageMin.Before(cursor) {
			break // no progress, avoid looping on identical endDates
		}
		cursor = pageMin.Add(-time.Second)
	}

	total := 0
	for cat, n := range counts {
		pendingMarkets.WithLabelValues(cat).Set(float64(n))
		total += n
	}
	if oldest.IsZero() {
		oldestPendingAge.Set(0)
	} else {
		oldestPendingAge.Set(now.Sub(oldest).Seconds())
	}
	log.Printf("[gamma] pending: %d markets past endDate unresolved (sports=%d politics=%d crypto=%d other=%d, oldest=%s)",
		total, counts["sports"], counts["politics"], counts["crypto"], counts["other"], oldest.Format(time.RFC3339))
}

func (g *gammaStore) pendingLoop(ctx context.Context) {
	g.refreshPending(ctx)
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.refreshPending(ctx)
		}
	}
}
