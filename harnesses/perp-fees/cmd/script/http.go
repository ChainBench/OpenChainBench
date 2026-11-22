package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

const (
	maxResponseBody = 4 << 20
	maxAPIMsg       = 200
)

var errBodyTooLarge = errors.New("body_too_large")

func getJSON(ctx context.Context, client *http.Client, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "OpenChainBench-PerpFees/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if err == nil && len(body) > maxResponseBody {
		err = errBodyTooLarge
	}
	if closeErr := resp.Body.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return &statusError{code: resp.StatusCode, body: truncate(string(body), maxAPIMsg)}
	}
	return json.Unmarshal(body, out)
}

type statusError struct {
	code int
	body string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("status_%d: %q", e.code, e.body)
}

func (e *statusError) errType() string {
	switch e.code {
	case http.StatusBadRequest, http.StatusNotFound:
		return errTypeNotFound
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusUnavailableForLegalReasons:
		return "auth"
	case http.StatusTooManyRequests, http.StatusTeapot:
		return "rate_limit"
	}
	if e.code >= http.StatusInternalServerError {
		return "server_error"
	}
	return "other"
}
