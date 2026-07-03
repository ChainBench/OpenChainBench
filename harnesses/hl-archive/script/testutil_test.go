package script

import "time"

// timeStub re-exports time.Time so the test files can stay terse.
type timeStub = time.Time

func parseDay(s string) time.Time {
	t, _ := time.Parse("2006-01-02", s)
	return t
}
