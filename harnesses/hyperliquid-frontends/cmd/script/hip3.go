package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HIP-3 dexes are metered from the chain's own info API, which every node
// serves and which needs no key: `perpDexs` lists the deployed dexes with
// their deployer and full name, `metaAndAssetCtxs` with a `dex` parameter
// returns each market's rolling 24h notional, open interest and mark price.
// The builder-fills feed does not carry the deployer fee, so this harness
// no longer publishes deployer revenue: volume, markets and open interest
// are what the chain exposes publicly.
const hlInfoURL = "https://api.hyperliquid.xyz/info"

var hip3HTTP = &http.Client{Timeout: 20 * time.Second}

type perpDex struct {
	Name     string `json:"name"`
	FullName string `json:"fullName"`
	Deployer string `json:"deployer"`
}

type hip3Universe struct {
	Name       string `json:"name"`
	IsDelisted bool   `json:"isDelisted"`
}

type hip3Ctx struct {
	DayNtlVlm    string `json:"dayNtlVlm"`
	OpenInterest string `json:"openInterest"`
	MarkPx       string `json:"markPx"`
}

func infoPost(ctx context.Context, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hlInfoURL, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "openchainbench-hl-frontends/2 (+https://openchainbench.com)")
	resp, err := hip3HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("info %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func pf(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

type hip3Poller struct {
	state *State
	mu    sync.Mutex
	known map[string]perpDex
}

func newHip3Poller(state *State) *hip3Poller {
	return &hip3Poller{state: state, known: make(map[string]perpDex)}
}

// pollOnce refreshes every dex. Returns the number of dexes updated.
func (p *hip3Poller) pollOnce(ctx context.Context) (int, error) {
	var dexes []*perpDex
	if err := infoPost(ctx, map[string]string{"type": "perpDexs"}, &dexes); err != nil {
		return 0, fmt.Errorf("perpDexs: %w", err)
	}
	now := time.Now().UTC()
	yesterday := dayKey(now.AddDate(0, 0, -1))
	updated := 0
	for _, d := range dexes {
		if d == nil || d.Name == "" {
			continue // index 0 is the core dex
		}
		var payload []json.RawMessage
		if err := infoPost(ctx, map[string]string{"type": "metaAndAssetCtxs", "dex": d.Name}, &payload); err != nil {
			log.Printf("hip3 %s: %v", d.Name, err)
			continue
		}
		if len(payload) < 2 {
			log.Printf("hip3 %s: short payload", d.Name)
			continue
		}
		var meta struct {
			Universe []hip3Universe `json:"universe"`
		}
		var ctxs []hip3Ctx
		if err := json.Unmarshal(payload[0], &meta); err != nil {
			log.Printf("hip3 %s meta: %v", d.Name, err)
			continue
		}
		if err := json.Unmarshal(payload[1], &ctxs); err != nil {
			log.Printf("hip3 %s ctxs: %v", d.Name, err)
			continue
		}
		var vol, oi float64
		listed, traded := 0, 0
		for i, u := range meta.Universe {
			if u.IsDelisted {
				continue
			}
			listed++
			if i >= len(ctxs) {
				continue
			}
			v := pf(ctxs[i].DayNtlVlm)
			vol += v
			if v > 0 {
				traded++
			}
			oi += pf(ctxs[i].OpenInterest) * pf(ctxs[i].MarkPx)
		}
		hip3Volume24h.WithLabelValues(d.Name).Set(vol)
		hip3Markets24h.WithLabelValues(d.Name).Set(float64(traded))
		hip3Listed.WithLabelValues(d.Name).Set(float64(listed))
		hip3OpenInt.WithLabelValues(d.Name).Set(oi)
		p.mu.Lock()
		if prev, ok := p.known[d.Name]; ok && (prev.FullName != d.FullName || prev.Deployer != d.Deployer) {
			hip3Info.DeleteLabelValues(d.Name, prev.FullName, prev.Deployer)
		}
		p.known[d.Name] = *d
		p.mu.Unlock()
		hip3Info.WithLabelValues(d.Name, d.FullName, strings.ToLower(d.Deployer)).Set(1)

		// One sample per UTC day, taken by the first poll after midnight:
		// dayNtlVlm at ~00:00 covers the day that just closed.
		if now.Hour() < 3 {
			p.state.setHip3Daily(d.Name, yesterday, vol)
		}
		daily := p.state.hip3DailyFor(d.Name)
		var v7, v30 float64
		sampled := 0
		for i := 0; i < 30; i++ {
			k := dayKey(now.AddDate(0, 0, -1-i))
			v, ok := daily[k]
			if !ok {
				continue
			}
			sampled++
			v30 += v
			if i < 7 {
				v7 += v
			}
		}
		hip3Volume7d.WithLabelValues(d.Name).Set(v7)
		hip3Volume30d.WithLabelValues(d.Name).Set(v30)
		hip3DaysSampled.WithLabelValues(d.Name).Set(float64(sampled))
		updated++
	}
	if updated > 0 {
		hip3LastTick.Set(float64(now.Unix()))
	}
	return updated, nil
}

func (p *hip3Poller) run(ctx context.Context, every time.Duration) {
	tick := func() {
		cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		n, err := p.pollOnce(cctx)
		if err != nil {
			log.Printf("hip3 poll: %v", err)
			return
		}
		if err := p.state.save(); err != nil {
			log.Printf("state save: %v", err)
		}
		log.Printf("hip3 poll: %d dexes", n)
	}
	tick()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}
