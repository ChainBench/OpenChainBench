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
	"os"
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

func main() {
	mode := os.Getenv("MODE")

	switch mode {
	case "fetch-html":
		// Fetch URL via utls, print body to stdout
		target := os.Getenv("URL")
		if target == "" {
			target = "https://www.defined.fi/"
		}
		client := newUTLSClient()
		req, _ := http.NewRequest("GET", target, nil)
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		req.Header.Set("Accept-Language", "en-US,en;q=0.9")
		resp, err := client.Do(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
			os.Exit(1)
		}
		defer resp.Body.Close()
		fmt.Fprintf(os.Stderr, "HTTP %d\n", resp.StatusCode)
		io.Copy(os.Stdout, resp.Body)

	case "scrape":
		// Step 1 only: GET defined.fi, print cookies
		client := newUTLSClient()
		req, _ := http.NewRequest("GET", "https://www.defined.fi/", nil)
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		req.Header.Set("Accept-Language", "en-US,en;q=0.9")
		req.Header.Set("Sec-Fetch-Site", "none")
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", "document")
		req.Header.Set("Upgrade-Insecure-Requests", "1")
		resp, err := client.Do(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
			os.Exit(1)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			fmt.Fprintf(os.Stderr, "ERROR: HTTP %d\n", resp.StatusCode)
			os.Exit(1)
		}
		u, _ := url.Parse("https://www.defined.fi/")
		for _, c := range client.Jar.Cookies(u) {
			fmt.Printf("%s=%s\n", c.Name, c.Value)
		}

	case "mint-utls":
		// Step 2 only via utls: POST /api/codex/token with pre-obtained cookies
		attestation := os.Getenv("ATTESTATION")
		csrf := os.Getenv("CSRF")
		if attestation == "" || csrf == "" {
			fmt.Fprintln(os.Stderr, "Need ATTESTATION and CSRF env vars")
			os.Exit(1)
		}
		fmt.Printf("Calling /api/codex/token via utls (Chrome fingerprint)...\n")
		client := newUTLSClient()
		// Inject cookies into jar
		u, _ := url.Parse("https://www.defined.fi/")
		client.Jar.SetCookies(u, []*http.Cookie{
			{Name: "defined-attestation-token", Value: attestation},
			{Name: "csrf-token", Value: csrf},
		})
		req, _ := http.NewRequest("POST", "https://www.defined.fi/api/codex/token", bytes.NewBufferString("{}"))
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-csrf-token", csrf)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		req.Header.Set("Accept-Language", "en-US,en;q=0.9")
		req.Header.Set("Origin", "https://www.defined.fi")
		req.Header.Set("Referer", "https://www.defined.fi/")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("Sec-Fetch-Mode", "cors")
		req.Header.Set("Sec-Fetch-Dest", "empty")
		resp, err := client.Do(req)
		if err != nil {
			fmt.Printf("ERROR: %v\n", err)
			os.Exit(1)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		fmt.Printf("HTTP %d\n", resp.StatusCode)
		if resp.StatusCode == 200 {
			var parsed struct{ Token string `json:"token"` }
			if err := json.Unmarshal(body, &parsed); err == nil && parsed.Token != "" {
				fmt.Printf("✅ Got JWE (len=%d)\n", len(parsed.Token))
				fmt.Printf("CODEX_TOKEN=%s\n", parsed.Token)
				return
			}
		}
		n := len(body)
		if n > 200 {
			n = 200
		}
		fmt.Printf("❌ Body: %s\n", string(body[:n]))
		os.Exit(1)

	default:
		// Full flow: scrape + mint on this machine
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
			fmt.Printf("Page load failed: %v\n", err)
			return
		}
		io.Copy(io.Discard, resp1.Body)
		resp1.Body.Close()
		fmt.Printf("Page: HTTP %d\n", resp1.StatusCode)
		u, _ := url.Parse("https://www.defined.fi/")
		cookies := client.Jar.Cookies(u)
		var attestation, csrf string
		for _, c := range cookies {
			switch c.Name {
			case "defined-attestation-token":
				attestation = c.Value
			case "csrf-token":
				csrf = c.Value
			}
		}
		fmt.Printf("attestation len=%d, csrf len=%d\n", len(attestation), len(csrf))
		req2, _ := http.NewRequest("POST", "https://www.defined.fi/api/codex/token", bytes.NewBufferString("{}"))
		req2.Header.Set("Accept", "application/json")
		req2.Header.Set("Content-Type", "application/json")
		req2.Header.Set("x-csrf-token", csrf)
		req2.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		req2.Header.Set("Origin", "https://www.defined.fi")
		req2.Header.Set("Referer", "https://www.defined.fi/")
		req2.Header.Set("Sec-Fetch-Site", "same-origin")
		req2.Header.Set("Sec-Fetch-Mode", "cors")
		resp2, err := client.Do(req2)
		if err != nil {
			fmt.Printf("API failed: %v\n", err)
			return
		}
		body, _ := io.ReadAll(resp2.Body)
		resp2.Body.Close()
		fmt.Printf("API: HTTP %d\n", resp2.StatusCode)
		if resp2.StatusCode == 200 {
			var parsed struct{ Token string `json:"token"` }
			if err := json.Unmarshal(body, &parsed); err == nil && parsed.Token != "" {
				fmt.Printf("✅ JWE len=%d\n", len(parsed.Token))
			}
		}
	}
}
