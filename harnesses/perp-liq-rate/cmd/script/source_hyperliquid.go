package main

// source_hyperliquid.go — Hyperliquid perps.
//
// Liquidations: 0xArchive REST API when OXARCHIVE_API_KEY is set (full
// coverage — all liquidation types including market-order fills). Fallback
// without a key: userFillsByTime on the HLP liquidator vault (backstop only,
// minority of volume).
// OI: POST /info {"type":"metaAndAssetCtxs"}; openInterest * midPx. ✓

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	hyperliquidInfoURL = "https://api.hyperliquid.xyz/info"
	hlpLiquidatorAddr  = "0x2e3d94f0562703b25c83308a05046ddaf9a8dd14"
	oxArchiveBaseURL   = "https://api.0xarchive.io"
	oxaMaxPages        = 20
	oxaPageLimit       = 1000
)

// Hyperliquid implements Source. It is stateless and shared across assets.
type Hyperliquid struct {
	infoURL        string // defaults to hyperliquidInfoURL
	archiveBaseURL string // 0xArchive API base, defaults to oxArchiveBaseURL
	archiveAPIKey  string // from env OXARCHIVE_API_KEY
}

// NewHyperliquid returns the Hyperliquid source.
func NewHyperliquid() *Hyperliquid {
	return &Hyperliquid{
		infoURL:        hyperliquidInfoURL,
		archiveBaseURL: oxArchiveBaseURL,
		archiveAPIKey:  os.Getenv("OXARCHIVE_API_KEY"),
	}
}

var hyperliquidCoins = map[string]string{
	"ETH": "ETH",
	"BTC": "BTC",
	"SOL": "SOL",
}

type hlFill struct {
	Coin        string          `json:"coin"`
	Px          string          `json:"px"`
	Sz          string          `json:"sz"`
	Time        int64           `json:"time"` // unix ms
	Hash        string          `json:"hash"`
	Tid         json.Number     `json:"tid"`
	Liquidation json.RawMessage `json:"liquidation"`
}

type oxaLiquidation struct {
	Coin      string `json:"coin"`
	Timestamp string `json:"timestamp"` // ISO 8601 with ms
	Price     string `json:"price"`
	Size      string `json:"size"`
	TradeID   int64  `json:"trade_id"`
}

type oxaResponse struct {
	Data []oxaLiquidation `json:"data"`
	Meta struct {
		NextCursor *string `json:"next_cursor"`
	} `json:"meta"`
}

// httpGetJSONKey performs a GET with an X-API-Key header.
func httpGetJSONKey(u, apiKey string, out any) error {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &httpStatusError{Code: resp.StatusCode}
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// fetchOxaLiquidations pages 0xArchive for all HL liquidation events.
func (h *Hyperliquid) fetchOxaLiquidations(coin string, sinceMs int64) ([]LiqEvent, error) {
	startISO := time.UnixMilli(sinceMs).UTC().Format(time.RFC3339)
	endISO := time.Now().UTC().Format(time.RFC3339)

	var events []LiqEvent
	cursor := ""

	for page := 0; page < oxaMaxPages; page++ {
		u := fmt.Sprintf("%s/v1/hyperliquid/liquidations/%s?start_time=%s&end_time=%s&limit=%d",
			h.archiveBaseURL,
			url.PathEscape(coin),
			url.QueryEscape(startISO),
			url.QueryEscape(endISO),
			oxaPageLimit,
		)
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}

		var resp oxaResponse
		if err := httpGetJSONKey(u, h.archiveAPIKey, &resp); err != nil {
			return nil, fmt.Errorf("hyperliquid 0xarchive: %w", err)
		}

		for _, liq := range resp.Data {
			px, err := parseF(liq.Price)
			if err != nil {
				return nil, fmt.Errorf("hyperliquid oxa px: %w", err)
			}
			sz, err := parseF(liq.Size)
			if err != nil {
				return nil, fmt.Errorf("hyperliquid oxa sz: %w", err)
			}
			ts, err := time.Parse(time.RFC3339Nano, liq.Timestamp)
			if err != nil {
				ts, err = time.Parse(time.RFC3339, liq.Timestamp)
				if err != nil {
					return nil, fmt.Errorf("hyperliquid oxa timestamp %q: %w", liq.Timestamp, err)
				}
			}
			events = append(events, LiqEvent{
				Key:         "oxa:" + strconv.FormatInt(liq.TradeID, 10),
				NotionalUSD: px * sz,
				TimestampMs: ts.UnixMilli(),
			})
		}

		if resp.Meta.NextCursor == nil || *resp.Meta.NextCursor == "" {
			break
		}
		cursor = *resp.Meta.NextCursor
	}
	return events, nil
}

// HasLiquidationSource reports true — 0xArchive or vault fallback is always available.
func (h *Hyperliquid) HasLiquidationSource() bool { return true }

// FetchLiquidationsSince returns liquidation events newer than sinceMs.
// Uses 0xArchive when OXARCHIVE_API_KEY is set; otherwise falls back to the
// HLP liquidator vault (backstop liquidations only).
func (h *Hyperliquid) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	coin, ok := hyperliquidCoins[asset]
	if !ok {
		return nil, fmt.Errorf("hyperliquid: unsupported asset %q", asset)
	}

	if h.archiveAPIKey != "" {
		return h.fetchOxaLiquidations(coin, sinceMs)
	}

	// Backstop-only fallback via HLP liquidator vault.
	payload := map[string]any{
		"type":      "userFillsByTime",
		"user":      hlpLiquidatorAddr,
		"startTime": sinceMs,
	}
	var fills []hlFill
	if err := httpPostJSON(h.infoURL, payload, &fills); err != nil {
		return nil, fmt.Errorf("hyperliquid userFillsByTime: %w", err)
	}

	events := make([]LiqEvent, 0, 8)
	for _, f := range fills {
		if !jsonNonNull(f.Liquidation) {
			continue
		}
		if f.Coin != coin {
			continue
		}
		if f.Time < sinceMs {
			continue
		}
		px, err := parseF(f.Px)
		if err != nil {
			return nil, fmt.Errorf("hyperliquid px: %w", err)
		}
		sz, err := parseF(f.Sz)
		if err != nil {
			return nil, fmt.Errorf("hyperliquid sz: %w", err)
		}
		key := f.Hash
		if key == "" || isZeroHash(key) {
			if f.Tid.String() != "" {
				key = "tid:" + f.Tid.String()
			} else {
				key = fmt.Sprintf("hl:%s:%d:%s:%s", coin, f.Time, f.Px, f.Sz)
			}
		}
		events = append(events, LiqEvent{
			Key:         key,
			NotionalUSD: px * sz,
			TimestampMs: f.Time,
		})
	}
	return events, nil
}

// FetchOI returns open interest in USD: openInterest (base units) * midPx.
func (h *Hyperliquid) FetchOI(asset string) (float64, error) {
	coin, ok := hyperliquidCoins[asset]
	if !ok {
		return 0, fmt.Errorf("hyperliquid: unsupported asset %q", asset)
	}

	payload := map[string]any{"type": "metaAndAssetCtxs"}
	var raw []json.RawMessage
	if err := httpPostJSON(h.infoURL, payload, &raw); err != nil {
		return 0, fmt.Errorf("hyperliquid metaAndAssetCtxs: %w", err)
	}
	if len(raw) < 2 {
		return 0, fmt.Errorf("hyperliquid metaAndAssetCtxs: expected 2-element array, got %d", len(raw))
	}

	var meta struct {
		Universe []struct {
			Name string `json:"name"`
		} `json:"universe"`
	}
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		return 0, fmt.Errorf("hyperliquid universe decode: %w", err)
	}
	var ctxs []struct {
		OpenInterest string `json:"openInterest"`
		MidPx        string `json:"midPx"`
		MarkPx       string `json:"markPx"`
	}
	if err := json.Unmarshal(raw[1], &ctxs); err != nil {
		return 0, fmt.Errorf("hyperliquid assetCtxs decode: %w", err)
	}

	for i, u := range meta.Universe {
		if u.Name != coin {
			continue
		}
		if i >= len(ctxs) {
			return 0, fmt.Errorf("hyperliquid: assetCtxs index %d out of range (%d)", i, len(ctxs))
		}
		oi, err := parseF(ctxs[i].OpenInterest)
		if err != nil {
			return 0, fmt.Errorf("hyperliquid openInterest: %w", err)
		}
		pxStr := ctxs[i].MidPx
		if strings.TrimSpace(pxStr) == "" {
			pxStr = ctxs[i].MarkPx
		}
		px, err := parseF(pxStr)
		if err != nil {
			return 0, fmt.Errorf("hyperliquid midPx: %w", err)
		}
		return oi * px, nil
	}
	return 0, fmt.Errorf("hyperliquid: coin %q not found in universe", coin)
}

// jsonNonNull reports whether a raw JSON field was present and not null.
func jsonNonNull(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s != "" && s != "null"
}

// isZeroHash reports whether s is a 0x-prefixed all-zero hash.
func isZeroHash(s string) bool {
	s = strings.TrimPrefix(strings.ToLower(s), "0x")
	if s == "" {
		return false
	}
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return true
}
