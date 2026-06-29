package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const codexWS = "wss://graph.codex.io/graphql"

func runCodex(ctx context.Context, cfg Config, basketCh <-chan []Market, kalshiBasketCh <-chan []Market) {
	if cfg.DefinedSessionCookie == "" {
		appendLog("[codex] DEFINED_SESSION_COOKIE not set — skipping Codex provider")
		return
	}

	// Codex uses its own composite marketId format. For Polymarket events:
	//   <conditionId>:Polymarket:<exchange>:<networkId>
	// For Kalshi events the trailing segment is `:Kalshi` and the leading
	// segment is the market_ticker. We branch on the suffix to pick venue
	// and which basket to check against.

	var (
		cidMu       sync.RWMutex
		knownPoly   = map[string]bool{}
		knownKalshi = map[string]bool{}
	)
	updateKnownPoly := func(ms []Market) {
		cidMu.Lock()
		defer cidMu.Unlock()
		knownPoly = map[string]bool{}
		for _, m := range ms {
			knownPoly[m.ConditionId] = true
		}
	}
	updateKnownKalshi := func(ms []Market) {
		cidMu.Lock()
		defer cidMu.Unlock()
		knownKalshi = map[string]bool{}
		for _, m := range ms {
			knownKalshi[m.ConditionId] = true
		}
	}
	isKnown := func(venue, cid string) bool {
		cidMu.RLock()
		defer cidMu.RUnlock()
		if venue == "kalshi" {
			return knownKalshi[cid]
		}
		return knownPoly[cid]
	}

	updateKnownPoly(currentBasket())
	updateKnownKalshi(currentKalshiBasket())

	// basket update consumers — Polymarket + Kalshi basket channels are
	// independent because each venue has its own refresh loop.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ms := <-basketCh:
				updateKnownPoly(ms)
			case ms := <-kalshiBasketCh:
				updateKnownKalshi(ms)
			}
		}
	}()

	backoff := 10 * time.Second
	consecutiveFails := 0
	for ctx.Err() == nil {
		err := codexConnect(ctx, cfg, isKnown)
		if ctx.Err() != nil {
			return
		}
		consecutiveFails++
		errType := classify(err)
		// Errors are reported on the polymarket venue to keep historical
		// series; Codex transport errors don't have a per-venue semantic.
		fetchErrors.WithLabelValues("codex", "polymarket", errType).Inc()
		appendLog("[codex] disconnected: %v — backing off %v", err, backoff)

		// Mirror the head-lag bench's recovery rules.
		if errType == "auth" || errType == "rate_limit" {
			InvalidateCodexJWT()
			backoff = 30 * time.Second
		}
		if consecutiveFails >= 10 {
			InvalidateCodexJWT()
			backoff = 10 * time.Second
			consecutiveFails = 0
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 60*time.Second {
			backoff *= 2
		}
	}
}

func codexConnect(ctx context.Context, cfg Config, isKnown func(venue, cid string) bool) error {
	jwt, err := GetCodexJWT(cfg.DefinedSessionCookie)
	if err != nil {
		return fmt.Errorf("mint: %w", err)
	}

	opts := &websocket.DialOptions{
		Subprotocols: []string{"graphql-transport-ws"},
		HTTPHeader: http.Header{
			"Origin":     []string{"https://www.defined.fi"},
			"User-Agent": []string{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0"},
		},
	}
	conn, _, err := websocket.Dial(ctx, codexWS, opts)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusInternalError, "")
	conn.SetReadLimit(8 * 1024 * 1024)

	init := map[string]interface{}{
		"type":    "connection_init",
		"payload": map[string]interface{}{"Authorization": "Bearer " + jwt},
	}
	ib, _ := json.Marshal(init)
	if err := conn.Write(ctx, websocket.MessageText, ib); err != nil {
		return fmt.Errorf("init: %w", err)
	}
	_, ackB, err := conn.Read(ctx)
	if err != nil {
		return fmt.Errorf("ack read: %w", err)
	}
	var ack struct {
		Type string `json:"type"`
	}
	json.Unmarshal(ackB, &ack)
	if ack.Type != "connection_ack" {
		return fmt.Errorf("expected connection_ack got %s", ack.Type)
	}
	appendLog("[codex] connection_ack")

	// Firehose subscription. We accept both Polymarket AND Kalshi trades
	// client-side because Codex's input doesn't take a protocol filter on
	// the subscription itself (only on the discovery query). The volume is
	// manageable — observed ~33 msg/sec mixing both venues.
	subQuery := `subscription Fire { onPredictionTradesCreated { marketId trades { timestamp transactionHash priceUsd amountUsd tradeType outcomeId outcomeLabel } } }`
	subMsg := map[string]interface{}{
		"type":    "subscribe",
		"id":      "firehose",
		"payload": map[string]interface{}{"query": subQuery, "variables": map[string]interface{}{}},
	}
	sb, _ := json.Marshal(subMsg)
	if err := conn.Write(ctx, websocket.MessageText, sb); err != nil {
		return fmt.Errorf("subscribe write: %w", err)
	}

	pingCtx, pingCancel := context.WithCancel(ctx)
	defer pingCancel()
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
				conn.Write(pingCtx, websocket.MessageText, []byte(`{"type":"ping"}`))
			}
		}
	}()

	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var m struct {
			Type    string          `json:"type"`
			Id      string          `json:"id"`
			Payload json.RawMessage `json:"payload"`
		}
		json.Unmarshal(b, &m)
		if m.Type != "next" {
			continue
		}
		var p struct {
			Data struct {
				OnPredictionTradesCreated struct {
					MarketId string `json:"marketId"`
					Trades   []struct {
						Timestamp       int64  `json:"timestamp"`
						TransactionHash string `json:"transactionHash"`
						PriceUsd        string `json:"priceUsd"`
						AmountUsd       string `json:"amountUsd"`
						TradeType       string `json:"tradeType"`
					} `json:"trades"`
				} `json:"onPredictionTradesCreated"`
			} `json:"data"`
		}
		if err := json.Unmarshal(m.Payload, &p); err != nil {
			continue
		}
		marketId := p.Data.OnPredictionTradesCreated.MarketId
		venue, cid := codexParseMarketId(marketId)
		logCodexMarketIDSample(marketId, venue, cid, isKnown(venue, cid))
		if cid == "" || venue == "" || !isKnown(venue, cid) {
			continue // out-of-basket, unknown venue, or unparsable id
		}
		health.WithLabelValues("codex", venue).Set(1)
		markAlive("codex", venue)
		now := nowSec()
		for _, t := range p.Data.OnPredictionTradesCreated.Trades {
			eventsTotal.WithLabelValues("codex", venue, "trade").Inc()
			sig := EventSig{
				Venue:       venue,
				ConditionId: cid,
				PriceMilli:  priceToMilli(t.PriceUsd),
				BucketSec:   bucketSec(float64(t.Timestamp)),
			}
			logSigSample("codex", sig)
			correlator.Add(sig, Arrival{Provider: "codex", Kind: "trade", RecvUnix: now})
		}
	}
}

// codexShapesMu + codexShapesLogged track which composite marketId
// shapes we've already logged a sample for. The goal is to surface every
// distinct shape Codex's firehose can emit in the first few minutes after
// boot — particularly important for Kalshi where the suffix format wasn't
// verified live. We log each (venue, known) tuple once per unique cid
// prefix shape, capped at 50 samples total.
var (
	codexShapesMu      sync.Mutex
	codexShapesSeen    = map[string]struct{}{}
	codexShapesLogged  int
	codexShapesCap     = 50
)

func logCodexMarketIDSample(marketId, venue, cid string, known bool) {
	if marketId == "" {
		return
	}
	codexShapesMu.Lock()
	defer codexShapesMu.Unlock()
	if codexShapesLogged >= codexShapesCap {
		return
	}
	// Shape key = venue + known + shape(marketId). Shape collapses hex
	// runs to "<hex>" and decimal runs to "<num>" so we don't log every
	// individual market.
	shape := shapeMarketID(marketId)
	key := fmt.Sprintf("%s|%t|%s", venue, known, shape)
	if _, ok := codexShapesSeen[key]; ok {
		return
	}
	codexShapesSeen[key] = struct{}{}
	codexShapesLogged++
	appendLog("[codex-debug] marketId=%s venue=%q cid=%q known=%t (sample %d/%d, shape=%s)",
		marketId, venue, cid, known, codexShapesLogged, codexShapesCap, shape)
}

// shapeMarketID replaces hex and decimal runs with placeholders so two
// otherwise-equivalent marketIds collapse to one shape string.
func shapeMarketID(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == '0' && i+1 < len(s) && (s[i+1] == 'x' || s[i+1] == 'X'):
			b.WriteString("<hex>")
			i += 2
			for i < len(s) && isHexDigit(s[i]) {
				i++
			}
		case c >= '0' && c <= '9':
			b.WriteString("<num>")
			for i < len(s) && s[i] >= '0' && s[i] <= '9' {
				i++
			}
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// codexParseMarketId splits Codex's composite marketId into (venue, id).
// Polymarket events look like  0x<conditionHex>:Polymarket:0x<exchange>:<network>
// Kalshi events look like      <market_ticker>:Kalshi
// Returns ("", "") if the format isn't recognised.
func codexParseMarketId(s string) (venue string, id string) {
	idx := strings.Index(s, ":")
	if idx <= 0 {
		return "", ""
	}
	id = strings.ToLower(s[:idx])
	rest := s[idx+1:]
	switch {
	case strings.HasPrefix(rest, "Polymarket"):
		return "polymarket", id
	case strings.HasPrefix(rest, "Kalshi"):
		return "kalshi", id
	}
	return "", ""
}
