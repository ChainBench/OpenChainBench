package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

// getProxyDialer returns a websocket.Dialer configured with proxy from env
// IMPORTANT: Forces new connection for each dial to enable proxy IP rotation
func getProxyDialer() *websocket.Dialer {
	dialer := &websocket.Dialer{
		// Force new TCP connection for each dial (no keep-alive reuse)
		// This ensures rotating proxy assigns a new IP from the pool
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			netDialer := &net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: -1, // Disable keep-alive to prevent connection reuse
			}
			return netDialer.DialContext(ctx, network, addr)
		},
		HandshakeTimeout: 30 * time.Second,
	}

	// Check for proxy configuration from environment
	proxyURL := os.Getenv("HTTP_PROXY")
	if proxyURL == "" {
		proxyURL = os.Getenv("HTTPS_PROXY")
	}

	if proxyURL != "" {
		parsedURL, err := url.Parse(proxyURL)
		if err == nil {
			dialer.Proxy = http.ProxyURL(parsedURL)
		}
	}

	return dialer
}

// getProxyDialerWithSubprotocols returns a websocket.Dialer with proxy and custom subprotocols
// Each call creates a FRESH dialer to ensure proxy IP rotation works correctly
func getProxyDialerWithSubprotocols(subprotocols []string) *websocket.Dialer {
	dialer := getProxyDialer()
	dialer.Subprotocols = subprotocols
	return dialer
}

// getProxyHTTPClient returns an http.Client configured with proxy from env
// IMPORTANT: Creates new client for each call to enable proxy IP rotation
func getProxyHTTPClient() *http.Client {
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			// Disable keep-alive to prevent connection reuse (enables proxy rotation)
			DisableKeepAlives: true,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: -1, // Disable keep-alive
			}).DialContext,
		},
	}

	// Check for proxy configuration from environment
	proxyURL := os.Getenv("HTTP_PROXY")
	if proxyURL == "" {
		proxyURL = os.Getenv("HTTPS_PROXY")
	}

	if proxyURL != "" {
		parsedURL, err := url.Parse(proxyURL)
		if err == nil {
			client.Transport.(*http.Transport).Proxy = http.ProxyURL(parsedURL)
		}
	}

	return client
}

// getOutboundIP fetches the current outbound IP address through the proxy
// Used to verify proxy IP rotation is working correctly
func getOutboundIP() (string, error) {
	client := getProxyHTTPClient()

	resp, err := client.Get("https://api.ipify.org?format=text")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return string(body), nil
}
