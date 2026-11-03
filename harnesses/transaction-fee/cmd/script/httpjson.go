package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// getJSON / postJSON: small helpers for the fetchers added with the
// Algorand, Aptos, NEAR and ICP rows. A non-200 keeps the first 200
// bytes of the body in the error so the "http 4xx" / "http 5xx"
// classification in classifyErr still applies.

func getJSON(c *http.Client, url string, out any) error {
	resp, err := c.Get(url)
	if err != nil {
		return err
	}
	return decodeJSONResp(resp, out)
}

func postJSON(c *http.Client, url string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	resp, err := c.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	return decodeJSONResp(resp, out)
}

func decodeJSONResp(resp *http.Response, out any) error {
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)]))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return nil
}
