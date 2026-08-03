package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const probeInterval = 5 * time.Minute

func main() {
	fmt.Println("=== Perp Exit Custody Monitor ===")
	fmt.Println("Bench № 123 — worst-case hours to withdraw without operator help.")
	fmt.Println()

	arbRPC := os.Getenv("ARB_RPC_URL")
	if arbRPC == "" {
		arbRPC = "https://arb1.arbitrum.io/rpc"
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println("Starting Prometheus metrics server on :2112")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runLoop(arbRPC, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runLoop(arbRPC string, stop <-chan struct{}) {
	tick := time.NewTicker(probeInterval)
	defer tick.Stop()

	probe(arbRPC)

	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			probe(arbRPC)
		}
	}
}

func probe(arbRPC string) {
	emitStatic()
	probeOstium(arbRPC)
	probeGains(arbRPC)
}
