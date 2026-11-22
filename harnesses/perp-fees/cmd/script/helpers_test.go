package main

import (
	"io"
	"net/http"
	"strings"
	"sync/atomic"
)

func near(got, want float64) bool {
	return abs(got-want) < 1e-9
}

func respond(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

type routeTransport map[string]string

func (r routeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for key, body := range r {
		if strings.Contains(req.URL.String(), key) {
			return respond(req, http.StatusOK, body), nil
		}
	}
	return respond(req, http.StatusNotFound, "no route"), nil
}

func fakeExchange(routes map[string]string) *http.Client {
	return &http.Client{Transport: routeTransport(routes)}
}

type statusTransport struct {
	status int
	body   string
	calls  *atomic.Int32
}

func (f statusTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if f.calls != nil {
		f.calls.Add(1)
	}
	return respond(req, f.status, f.body), nil
}

func statusClient(status int, body string) *http.Client {
	return &http.Client{Transport: statusTransport{status: status, body: body}}
}
