// hl-archive — Hyperliquid builder fee/volume archive service.
//
// Entrypoint only: parses the subcommand off os.Args and forwards to
// the dispatcher in ../../script. Keeping main.go thin makes the
// subcommand handlers individually testable and lets the rest of the
// package live under a single import path that mirrors the OCB
// miniapp convention (script/*).
package main

import (
	"fmt"
	"os"

	hlarchive "hl-archive/script"
)

func main() {
	if err := hlarchive.Run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "[hl-archive] FATAL: %v\n", err)
		os.Exit(1)
	}
}
