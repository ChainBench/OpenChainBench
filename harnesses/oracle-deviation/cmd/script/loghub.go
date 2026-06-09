package main

// Stub for the public OCB mirror. The private mobula-monorepo deploy
// captures stdout into a ring buffer served at /logs?tail=N (X-Logs-Token
// gated) for the openbench-monitoring admin UI. The public harness has
// no logs endpoint — it's a transparency mirror, not an operated
// service. Keeping the call site identical lets the two harnesses share
// the rest of the code 1:1.
func installLogCapture() {}
