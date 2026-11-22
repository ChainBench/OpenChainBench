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
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), maxAPIMsg))
	}
	return json.Unmarshal(body, out)
}
