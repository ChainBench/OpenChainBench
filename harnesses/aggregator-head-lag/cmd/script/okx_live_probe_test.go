package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Opt-in live check: go test ./cmd/script -run TestOKXLiveFeed -okx-live
//
// It runs the monitor's OWN decoder against the gateway, which the unit tests
// cannot do and which is exactly where this integration went wrong twice: a
// hand-written probe with its own copy of the struct said the feed was fine
// while the shipped monitor decoded nothing. Skipped by default so CI never
// depends on a third party.
var okxLive = false

func init() { //nolint:gochecknoinits // test-only flag registration
	// Registered as a bool var rather than a flag so `go test ./...` stays
	// hermetic and no CI invocation can turn it on by accident.
	_ = okxLive
}

func TestOKXLiveFeed(t *testing.T) {
	if !okxLive {
		t.Skip("live feed check, flip okxLive to run it by hand")
	}
	conn, _, err := (&websocket.Dialer{HandshakeTimeout: 15 * time.Second}).Dial(okxWSURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", okxWSURL, err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"op": "subscribe",
		"args": []map[string]string{{
			"channel":     okxChannel,
			"extraParams": okxExtraParams("8453", "0x4200000000000000000000000000000000000006"),
		}},
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	decoded, withHash := 0, 0
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline.Add(2 * time.Second))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if string(msg) == "pong" {
			continue
		}
		var f okxFrame
		if json.Unmarshal(msg, &f) != nil || f.Event != "" {
			continue
		}
		for _, tr := range okxFrameTrades(f.Data) {
			decoded++
			if len(tr.TxHash) >= 10 {
				withHash++
			}
		}
	}
	t.Logf("decoded %d trades, %d with a hash", decoded, withHash)
	if decoded == 0 {
		t.Fatal("the gateway pushed frames the monitor's decoder could not read; " +
			"an ack is not evidence, only decoded trades are")
	}
	if withHash != decoded {
		t.Errorf("%d of %d trades carried no usable hash, so they could never match "+
			"the reference", decoded-withHash, decoded)
	}
}
