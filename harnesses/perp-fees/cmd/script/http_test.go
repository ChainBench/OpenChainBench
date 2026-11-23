package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestGetJSON_ErrorStatus(t *testing.T) {
	tests := []struct {
		status int
		want   string
	}{
		{status: http.StatusServiceUnavailable, want: "server_error"},
		{status: http.StatusTooManyRequests, want: "rate_limit"},
		{status: http.StatusUnavailableForLegalReasons, want: "auth"},
		{status: http.StatusBadRequest, want: errTypeNotFound},
		{status: http.StatusConflict, want: "other"},
	}
	for _, tc := range tests {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			var book pairBook
			client := statusClient(tc.status, numBook)
			err := getJSON(context.Background(), client, "https://cex.test/depth", &book)
			if got := cexErrType(err); got != tc.want || len(book.Asks) != 0 {
				t.Errorf("type=%q asks=%v, want %q and no book", got, book.Asks, tc.want)
			}
		})
	}
}

func TestGetJSON_EscapesErrorBody(t *testing.T) {
	client := statusClient(http.StatusBadGateway, "down\n[PERP][binance/ETH] all_in=1.00bps")
	var book pairBook
	err := getJSON(context.Background(), client, "https://cex.test/depth", &book)
	if err == nil || strings.Contains(err.Error(), "\n") {
		t.Errorf("err=%q, want one escaped line", err)
	}
}

func TestGetJSON_StopsReadingPastCap(t *testing.T) {
	client := &http.Client{Transport: endlessTransport{}}
	var book pairBook
	err := getJSON(context.Background(), client, "https://cex.test/depth", &book)
	if !errors.Is(err, errBodyTooLarge) {
		t.Errorf("err=%v, want %v", err, errBodyTooLarge)
	}
}

var errReadPastCap = errors.New("read_past_cap")

type endlessBody struct{ read int }

func (b *endlessBody) Read(p []byte) (int, error) {
	if b.read > maxResponseBody {
		return 0, errReadPastCap
	}
	for i := range p {
		p[i] = 'x'
	}
	b.read += len(p)
	return len(p), nil
}

func (b *endlessBody) Close() error { return nil }

type endlessTransport struct{}

func (endlessTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: &endlessBody{}, Request: req}, nil
}
