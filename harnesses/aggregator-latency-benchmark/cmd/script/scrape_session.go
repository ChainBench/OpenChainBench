package main

import (
	"context"
	"fmt"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

func ScrapeDefinedSessionCookie() (string, error) {
	// Create Chrome context with headless mode
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var sessionCookie string

	err := chromedp.Run(ctx,
		chromedp.Navigate("https://www.defined.fi/"),
		chromedp.WaitVisible(`body`, chromedp.ByQuery),
		chromedp.Sleep(5*time.Second),

		chromedp.ActionFunc(func(ctx context.Context) error {
			cookieParams, err := network.GetCookies().Do(ctx)
			if err != nil {
				return fmt.Errorf("failed to get cookies: %w", err)
			}

			for _, cookie := range cookieParams {
				if cookie.Name == "session" {
					sessionCookie = cookie.Value
					return nil
				}
			}

			return fmt.Errorf("session cookie not found")
		}),
	)

	if err != nil {
		return "", fmt.Errorf("failed to scrape session cookie: %w", err)
	}

	return sessionCookie, nil
}

