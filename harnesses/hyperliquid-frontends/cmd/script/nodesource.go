package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// The Hyperliquid node's own fill stream, reduced to per-builder daily
// totals by harnesses/hl-fills-reduce on the Singapore box.
//
// Why a second source. The public per-builder export this harness mirrors
// stops at roughly 12:10 UTC on most days since 2026-09-08, so a window sum
// built from it lands near half the real figure. Measured on fomo for
// 2026-10-06: the export carried $53.1M of notional and $25,288 of builder
// fees; the node's own stream for the same day carries $192.5M and $93,131,
// and CoinMarketMan, reading a complete feed, published $93.1K for that day.
// The export is not a smaller measurement of the same thing, it is most of a
// day missing.
//
// So where the node has a whole day, that day replaces the export outright.
// The two are never averaged or reconciled: two readings of one quantity
// that differ by a factor of two are not two readings. A day the node only
// half covers is left to the export, which may well have the other half, and
// the coverage gauges go on saying which days are whole.
//
// The node box is reachable only from this VPS (ufw), and Caddy puts basic
// auth in front of everything but /healthz.

const (
	nodeDaysPath  = "/days"
	nodeDailyPath = "/daily/"
)

// nodeDayIndex is one entry of the reducer's /days listing.
type nodeDayIndex struct {
	Day      string `json:"day"`
	Hours    int    `json:"hours"`
	Complete bool   `json:"complete"`
}

type nodeUserAgg struct {
	Vol   float64 `json:"v"`
	Pnl   float64 `json:"p"`
	Fee   float64 `json:"f"`
	Fills int     `json:"n"`
}

type nodeTotals struct {
	VolumeUSD float64                 `json:"v"`
	FeesUSD   float64                 `json:"f"`
	Fills     int                     `json:"n"`
	Taker     int                     `json:"t"`
	LastFill  int64                   `json:"l"`
	CoinVol   map[string]float64      `json:"c"`
	Users     map[string]*nodeUserAgg `json:"u"`
}

type nodeDay struct {
	Schema   int                    `json:"schema"`
	Day      string                 `json:"day"`
	Hours    int                    `json:"hours"`
	Complete bool                   `json:"complete"`
	Builders map[string]*nodeTotals `json:"builders"`
}

// nodeSchema is the reduced shape this understands. A day written under a
// different shape is ignored rather than decoded into zeros.
const nodeSchema = 2

// NodeSource fetches and caches reduced days.
type NodeSource struct {
	BaseURL string
	User    string
	Pass    string
	Client  *http.Client

	mu    sync.Mutex
	index map[string]nodeDayIndex // day -> listing entry, refreshed each sweep
	days  map[string]*nodeDay     // day -> parsed, only whole days are kept
}

// newNodeSource returns nil when the endpoint is not configured, which is the
// normal state in local development and on any deploy without the node.
func newNodeSource(timeout time.Duration) *NodeSource {
	base := strings.TrimRight(os.Getenv("HL_NODE_REDUCE_URL"), "/")
	if base == "" {
		return nil
	}
	user, pass := os.Getenv("HL_NODE_REDUCE_USER"), os.Getenv("HL_NODE_REDUCE_PASS")
	return &NodeSource{
		BaseURL: base,
		User:    user,
		Pass:    pass,
		Client:  &http.Client{Timeout: timeout},
		index:   map[string]nodeDayIndex{},
		days:    map[string]*nodeDay{},
	}
}

func (n *NodeSource) get(path string) (io.ReadCloser, error) {
	req, err := http.NewRequest(http.MethodGet, n.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	if n.User != "" {
		req.SetBasicAuth(n.User, n.Pass)
	}
	// The reducer stores days gzipped and serves them as stored, so ask for
	// the bytes rather than letting the transport transparently inflate
	// something it then has to re-tag.
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := n.Client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s: %s", path, resp.Status)
	}
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			resp.Body.Close()
			return nil, err
		}
		return readCloserPair{zr, resp.Body}, nil
	}
	return resp.Body, nil
}

type readCloserPair struct {
	io.Reader
	under io.Closer
}

func (p readCloserPair) Close() error { _ = p.under.Close(); return nil }

// Refresh re-reads the listing. Days already cached as whole are kept; a day
// that was partial when cached is dropped so the next read picks up the hours
// the node has since backfilled.
func (n *NodeSource) Refresh() error {
	body, err := n.get(nodeDaysPath)
	if err != nil {
		return err
	}
	defer body.Close()
	var list []nodeDayIndex
	if err := json.NewDecoder(body).Decode(&list); err != nil {
		return err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.index = make(map[string]nodeDayIndex, len(list))
	for _, e := range list {
		n.index[e.Day] = e
		if !e.Complete {
			delete(n.days, e.Day)
		}
	}
	return nil
}

// WholeDays is the set of days the node covered end to end.
func (n *NodeSource) WholeDays() map[string]bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make(map[string]bool, len(n.index))
	for d, e := range n.index {
		if e.Complete {
			out[d] = true
		}
	}
	return out
}

// Summary returns one builder's day from the node, or nil when the node does
// not have that day whole. Addresses are matched case-insensitively and
// summed across a builder's secondary addresses, the same way the mirror path
// merges them.
func (n *NodeSource) Summary(addrs []string, day string) *daySummary {
	d := n.day(day)
	if d == nil {
		return nil
	}
	var out *daySummary
	for _, a := range addrs {
		t := d.Builders[strings.ToLower(a)]
		if t == nil {
			continue
		}
		if out == nil {
			out = newDaySummary()
		}
		out.vol += t.VolumeUSD
		out.fees += t.FeesUSD
		out.fills += t.Fills
		out.taker += t.Taker
		if t.LastFill > out.lastFillS {
			out.lastFillS = t.LastFill
		}
		for c, v := range t.CoinVol {
			out.coinVol[c] += v
		}
		for u, ua := range t.Users {
			cur := out.users[u]
			cur.vol += ua.Vol
			cur.pnl += ua.Pnl
			cur.fee += ua.Fee
			cur.fills += ua.Fills
			out.users[u] = cur
		}
	}
	return out
}

// day returns a cached whole day, fetching it once.
func (n *NodeSource) day(day string) *nodeDay {
	n.mu.Lock()
	if d, ok := n.days[day]; ok {
		n.mu.Unlock()
		return d
	}
	e, known := n.index[day]
	n.mu.Unlock()
	if !known || !e.Complete {
		return nil
	}

	body, err := n.get(nodeDailyPath + day)
	if err != nil {
		return nil
	}
	defer body.Close()
	var d nodeDay
	if err := json.NewDecoder(body).Decode(&d); err != nil {
		return nil
	}
	if d.Schema != nodeSchema || !d.Complete {
		return nil
	}
	n.mu.Lock()
	n.days[day] = &d
	n.mu.Unlock()
	return &d
}

// Evict drops cached days outside the window so a long-running process does
// not hold the whole archive in memory.
func (n *NodeSource) Evict(keep map[string]bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for d := range n.days {
		if !keep[d] {
			delete(n.days, d)
		}
	}
}
