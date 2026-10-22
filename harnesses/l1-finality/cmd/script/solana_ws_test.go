package main

import "testing"

func TestParseSolanaNotifications(t *testing.T) {
	slot, root, ok := parseSolanaNotification([]byte(`{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":9,"root":5,"slot":10},"subscription":1}}`))
	if !ok || slot != 10 || root != 0 {
		t.Fatalf("slot: got %d %d %v", slot, root, ok)
	}
	slot, root, ok = parseSolanaNotification([]byte(`{"jsonrpc":"2.0","method":"rootNotification","params":{"result":42,"subscription":2}}`))
	if !ok || slot != 0 || root != 42 {
		t.Fatalf("root: got %d %d %v", slot, root, ok)
	}
	if _, _, ok := parseSolanaNotification([]byte(`{"jsonrpc":"2.0","result":7,"id":1}`)); ok {
		t.Fatal("a subscription ack is not a notification")
	}
}
