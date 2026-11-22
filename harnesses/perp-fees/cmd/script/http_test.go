package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestGetJSON_ServerError(t *testing.T) {
	client := &http.Client{
		Transport: fixedTransport{status: http.StatusServiceUnavailable, body: numBook},
	}
	var book pairBook
	if err := getJSON(context.Background(), client, "https://cex.test/depth", &book); err == nil {
		t.Errorf("book=%+v, want an error", book)
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

type fixedTransport struct {
	status int
	body   string
}

func (f fixedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return respond(req, f.status, f.body), nil
}

var errReadPastCap = errors.New("read past the body cap")

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
