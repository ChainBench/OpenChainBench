package main

import "testing"

func TestParseBlockCount(t *testing.T) {
	if n, err := parseBlockCount([]byte(`{"id":1,"jsonrpc":"1.0","result":3200892,"error":null}`)); err != nil || n != 3200892 {
		t.Fatalf("got %d %v", n, err)
	}
	if _, err := parseBlockCount([]byte(`{"id":1,"result":null,"error":{"message":"busy"}}`)); err == nil {
		t.Fatal("rpc error must surface")
	}
}
