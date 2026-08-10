package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"time"

	tls "github.com/refraction-networking/utls"
)

func chromeH1Spec() tls.ClientHelloSpec {
	return tls.ClientHelloSpec{
		TLSVersMax: tls.VersionTLS13,
		TLSVersMin: tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.GREASE_PLACEHOLDER,
			tls.TLS_AES_128_GCM_SHA256,
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			tls.TLS_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_RSA_WITH_AES_128_CBC_SHA,
			tls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []byte{0x00},
		Extensions: tls.ShuffleChromeTLSExtensions([]tls.TLSExtension{
			&tls.UtlsGREASEExtension{},
			&tls.SNIExtension{},
			&tls.ExtendedMasterSecretExtension{},
			&tls.RenegotiationInfoExtension{Renegotiation: tls.RenegotiateOnceAsClient},
			&tls.SupportedCurvesExtension{[]tls.CurveID{
				tls.GREASE_PLACEHOLDER, tls.X25519, tls.CurveP256, tls.CurveP384,
			}},
			&tls.SupportedPointsExtension{SupportedPoints: []byte{0x00}},
			&tls.SessionTicketExtension{},
			&tls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&tls.StatusRequestExtension{},
			&tls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []tls.SignatureScheme{
				tls.ECDSAWithP256AndSHA256, tls.PSSWithSHA256, tls.PKCS1WithSHA256,
				tls.ECDSAWithP384AndSHA384, tls.PSSWithSHA384, tls.PKCS1WithSHA384,
				tls.PSSWithSHA512, tls.PKCS1WithSHA512,
			}},
			&tls.SCTExtension{},
			&tls.KeyShareExtension{[]tls.KeyShare{
				{Group: tls.CurveID(tls.GREASE_PLACEHOLDER), Data: []byte{0}},
				{Group: tls.X25519},
			}},
			&tls.PSKKeyExchangeModesExtension{[]uint8{tls.PskModeDHE}},
			&tls.SupportedVersionsExtension{[]uint16{
				tls.GREASE_PLACEHOLDER, tls.VersionTLS13, tls.VersionTLS12,
			}},
			&tls.UtlsCompressCertExtension{[]tls.CertCompressionAlgo{tls.CertCompressionBrotli}},
			&tls.UtlsGREASEExtension{},
			&tls.UtlsPaddingExtension{GetPaddingLen: tls.BoringPaddingStyle},
		}),
	}
}

func newUTLSClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Timeout: 30 * time.Second,
		Jar:     jar,
		Transport: &http.Transport{
			DisableKeepAlives: true,
			ForceAttemptHTTP2: false,
			DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, _, _ := net.SplitHostPort(addr)
				conn, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, network, addr)
				if err != nil {
					return nil, err
				}
				spec := chromeH1Spec()
				uc := tls.UClient(conn, &tls.Config{ServerName: host}, tls.HelloCustom)
				if err := uc.ApplyPreset(&spec); err != nil {
					conn.Close()
					return nil, err
				}
				if err := uc.HandshakeContext(ctx); err != nil {
					conn.Close()
					return nil, err
				}
				return uc, nil
			},
		},
	}
}

// tryUtlsCodexToken uses Chrome TLS fingerprint spoofing to call /api/codex/token.
// Works from residential IPs. From datacenter IPs Vercel may return 429.
func tryUtlsCodexToken() (string, error) {
	client := newUTLSClient()

	req1, _ := http.NewRequest("GET", "https://www.defined.fi/", nil)
	req1.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req1.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req1.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req1.Header.Set("Sec-Fetch-Site", "none")
	req1.Header.Set("Sec-Fetch-Mode", "navigate")
	req1.Header.Set("Sec-Fetch-Dest", "document")
	req1.Header.Set("Upgrade-Insecure-Requests", "1")

	resp1, err := client.Do(req1)
	if err != nil {
		return "", fmt.Errorf("page load failed: %w", err)
	}
	io.Copy(io.Discard, resp1.Body)
	resp1.Body.Close()

	if resp1.StatusCode != 200 {
		return "", fmt.Errorf("page load blocked (HTTP %d) — IP blocked by Vercel", resp1.StatusCode)
	}

	u, _ := url.Parse("https://www.defined.fi/")
	cookies := client.Jar.Cookies(u)
	var csrfToken string
	for _, c := range cookies {
		if c.Name == "csrf-token" {
			csrfToken = c.Value
		}
	}
	if csrfToken == "" {
		return "", fmt.Errorf("no csrf-token in page cookies")
	}

	req2, _ := http.NewRequest("POST", "https://www.defined.fi/api/codex/token", bytes.NewBufferString("{}"))
	req2.Header.Set("Accept", "application/json")
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("x-csrf-token", csrfToken)
	req2.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req2.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req2.Header.Set("Origin", "https://www.defined.fi")
	req2.Header.Set("Referer", "https://www.defined.fi/")
	req2.Header.Set("Sec-Fetch-Site", "same-origin")
	req2.Header.Set("Sec-Fetch-Mode", "cors")
	req2.Header.Set("Sec-Fetch-Dest", "empty")

	resp2, err := client.Do(req2)
	if err != nil {
		return "", fmt.Errorf("codex/token request failed: %w", err)
	}
	body, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()

	if resp2.StatusCode != 200 {
		return "", fmt.Errorf("codex/token HTTP %d: %.100s", resp2.StatusCode, string(body))
	}

	var parsed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Token == "" {
		return "", fmt.Errorf("no token in response: %.100s", string(body))
	}

	return parsed.Token, nil
}
