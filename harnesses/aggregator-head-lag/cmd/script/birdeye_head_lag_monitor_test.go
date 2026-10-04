package main

import (
	"bytes"
	"compress/zlib"
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The User-Agent is the whole gate. Measured one factor at a time against the
// live endpoint: no headers 403, Origin alone 403, Origin + User-Agent 101.
// Dropping either turns every dial into a 403 that reads like a dead socket.
func TestBirdeyeHeadersCarryTheGate(t *testing.T) {
	h := birdeyeHeaders()
	if h.Get("User-Agent") == "" {
		t.Error("no User-Agent: Cloudflare answers 403 \"Just a moment...\" and the " +
			"monitor looks like it is talking to a closed socket")
	}
	if h.Get("Origin") != "https://birdeye.so" {
		t.Errorf("Origin = %q, want https://birdeye.so", h.Get("Origin"))
	}
	// A UA that does not look like a browser is the same failure in slow motion.
	if ua := h.Get("User-Agent"); len(ua) < 40 || !bytes.Contains([]byte(ua), []byte("Mozilla")) {
		t.Errorf("User-Agent does not look like a browser: %q", ua)
	}
}

// Trade frames are zlib-compressed JSON. DevTools calls them "Binary message",
// which reads like protobuf until you notice the 78 9c magic; decoding them as
// text yields nothing and the monitor scores silently.
func TestBirdeyeInflateHandlesBothFrameKinds(t *testing.T) {
	plain := `{"type":"ACK","data":{"ack_id":"x"}}`
	if got := birdeyeInflate([]byte(plain)); got != plain {
		t.Errorf("a text frame must pass through unchanged, got %q", got)
	}

	payload := `{"type":"TXS_DATA","data":[{"txHash":"abc","blockUnixTime":1791115928}]}`
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	_, _ = w.Write([]byte(payload))
	_ = w.Close()
	if got := birdeyeInflate(buf.Bytes()); got != payload {
		t.Errorf("a zlib frame must inflate, got %q", got)
	}

	// Garbage that merely starts with 0x78 must not panic or return nonsense.
	if got := birdeyeInflate([]byte{0x78, 0x01, 0x02}); got == "" {
		t.Error("a malformed frame must still return something rather than panic")
	}
}

// A live TXS_DATA frame, verbatim from the wire, must decode to a usable hash.
func TestBirdeyeDecodesALiveFrame(t *testing.T) {
	// Captured from multichain-socket.birdeye.so/solana/socket-optimize.
	raw := `{"type":"TXS_DATA","data":[{"blockUnixTime":1791115928,` +
		`"owner":"ATmC4ZjbSraisHP7HopESDv36WHtTbwELTXqYkP5iwUk","source":"Orca",` +
		`"txHash":"5cyZDmq8vkyTnPvTAjDDrM2smLhQrzxpCRYqtWRbyWFiSDrBcN2pVKBcDCd49aZoNgdqFJ7uXQiSy6BzVYQ1rC3y",` +
		`"side":"buy","tokenAddress":"Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"}]}`
	var f birdeyeFrame
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatalf("live frame did not decode: %v", err)
	}
	if f.Type != "TXS_DATA" || len(f.Data) != 1 {
		t.Fatalf("type=%q trades=%d", f.Type, len(f.Data))
	}
	if len(f.Data[0].TxHash) < 80 {
		t.Errorf("hash too short to be a solana signature: %q", f.Data[0].TxHash)
	}
	if f.Data[0].BlockUnixTime < 1e9 {
		t.Errorf("blockUnixTime = %v, want unix seconds", f.Data[0].BlockUnixTime)
	}
}

// Only TXS_DATA carries trades. GEM_CHANGED (token statistics) and PRICE_DATA
// (OHLCV candles) arrive on the same socket and must never be scored: neither
// has a transaction hash, so both would enqueue empty hashes forever.
func TestBirdeyeIgnoresTheOtherFrameTypes(t *testing.T) {
	for _, raw := range []string{
		`{"type":"GEM_CHANGED","data":{"tokens":{"x":{"price":159.4}}}}`,
		`{"type":"PRICE_DATA","data":[{"o":159.4,"c":159.6,"eventType":"ohlcv"}]}`,
		`{"type":"WELLCOME","data":{"id_1":"abc"}}`,
		`{"type":"ACK","data":{"ack_id":"abc"}}`,
	} {
		var f birdeyeFrame
		_ = json.Unmarshal([]byte(raw), &f)
		if f.Type == "TXS_DATA" {
			t.Errorf("frame misclassified as trades: %s", raw)
		}
	}
}

// Same gate as OKX: every measured chain must be one whose headline avoids the
// provider's own timestamp, because blockUnixTime is in whole seconds.
func TestBirdeyeChainsAvoidTheProviderTimestamp(t *testing.T) {
	for _, c := range birdeyeChains {
		if !referenceChains[c.ChainName] && !raceChains[c.ChainName] {
			t.Errorf("chain %q publishes receiveTime minus the provider's own timestamp, "+
				"and birdeye sends whole seconds", c.ChainName)
		}
		found := false
		for _, p := range headLagPools {
			if p.ChainName == c.ChainName {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("chain %q is not a bench pool, so there is no reference to match against", c.ChainName)
		}
	}
}

// Undocumented frontend infrastructure: pin the endpoint so a silent move
// fails loudly rather than quietly measuring nothing.
func TestBirdeyeEndpointIsPinned(t *testing.T) {
	if birdeyeWSHost != "wss://multichain-socket.birdeye.so" {
		t.Errorf("host changed to %q. Note the documented public-api.birdeye.so "+
			"socket needs a $199/month plan; verify any new host is open before shipping.",
			birdeyeWSHost)
	}
	for _, c := range birdeyeChains {
		if c.Path == "" || c.Path[0] != '/' {
			t.Errorf("chain %q has a malformed path %q", c.ChainName, c.Path)
		}
	}
}

// Opt-in live check: flip birdeyeLive and run
// go test ./cmd/script -run TestBirdeyeLiveFeed
//
// It exercises the monitor's own header set, inflater and frame type against
// the real endpoint. The OKX integration shipped broken twice because a probe
// with its own copy of the decoder said the feed was fine.
var birdeyeLive = false

func TestBirdeyeLiveFeed(t *testing.T) {
	if !birdeyeLive {
		t.Skip("live feed check, flip birdeyeLive to run it by hand")
	}
	conn, resp, err := (&websocket.Dialer{HandshakeTimeout: 20 * time.Second}).
		Dial(birdeyeWSHost+"/solana/socket-optimize", birdeyeHeaders())
	if err != nil {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		t.Fatalf("dial failed (HTTP %d): %v", code, err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"type": "SUBSCRIBE_TXS",
		"data": map[string]any{
			"address": "So11111111111111111111111111111111111111112",
			"filter":  map[string]any{},
		},
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	decoded, withHash := 0, 0
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline.Add(2 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var f birdeyeFrame
		if json.Unmarshal([]byte(birdeyeInflate(raw)), &f) != nil || f.Type != "TXS_DATA" {
			continue
		}
		for _, tr := range f.Data {
			decoded++
			if len(tr.TxHash) > 40 {
				withHash++
			}
		}
	}
	t.Logf("decoded %d trades, %d with a hash", decoded, withHash)
	if decoded == 0 {
		t.Fatal("connected but decoded nothing; an ack is not evidence, only trades are")
	}
	if withHash != decoded {
		t.Errorf("%d of %d trades carried no usable hash", decoded-withHash, decoded)
	}
}
