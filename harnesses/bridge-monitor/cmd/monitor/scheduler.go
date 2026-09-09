package main

import (
	"log"
	"time"
)

// Schedule defines when execution tests run.
// Uses fixed UTC times so redeploys don't affect the rhythm.
//
// Two tiers only ($3 and $30 — the $300 tier was retired): the loop is now a
// small, self-balancing carousel whose point is settlement reliability, not
// large-ticket cost. $3 runs daily for a dense datapoint, $30 twice a week for
// a larger-notional read.
type Schedule struct {
	// $3 tests: daily at these hours UTC
	Hours3USD []int // e.g. [10] = 10:00 UTC daily

	// $30 tests: specific weekdays at hour UTC
	// 0=Sunday, 1=Monday, ..., 6=Saturday
	Weekdays30USD []time.Weekday
	Hour30USD     int
}

// DefaultSchedule returns the default execution schedule.
// $3:  daily at 10:00 UTC
// $30: Monday & Thursday at 10:00 UTC
func DefaultSchedule() *Schedule {
	return &Schedule{
		Hours3USD:     []int{10}, // 10:00 UTC daily
		Weekdays30USD: []time.Weekday{time.Monday, time.Thursday},
		Hour30USD:     10,
	}
}

// Scheduler handles fixed-time execution scheduling.
type Scheduler struct {
	schedule   *Schedule
	exec3Chan  chan struct{}
	exec30Chan chan struct{}
	stopChan   chan struct{}
}

// NewScheduler creates a new scheduler with fixed times.
func NewScheduler(schedule *Schedule) *Scheduler {
	if schedule == nil {
		schedule = DefaultSchedule()
	}
	return &Scheduler{
		schedule:   schedule,
		exec3Chan:  make(chan struct{}, 1),
		exec30Chan: make(chan struct{}, 1),
		stopChan:   make(chan struct{}),
	}
}

// Start begins the scheduler goroutines.
func (s *Scheduler) Start() {
	log.Println("📅 Scheduler started with fixed UTC times:")
	log.Printf("   $3 tests:  daily at %v:00 UTC", s.schedule.Hours3USD)
	log.Printf("   $30 tests: %v at %02d:00 UTC", s.schedule.Weekdays30USD, s.schedule.Hour30USD)

	s.logNextScheduledTimes()

	go s.run3USDScheduler()
	go s.run30USDScheduler()
}

// logNextScheduledTimes logs when the next tests will run.
func (s *Scheduler) logNextScheduledTimes() {
	now := time.Now().UTC()

	next3 := s.nextTime3USD(now)
	next30 := s.nextTime30USD(now)

	log.Printf("   Next $3 test:  %s (in %v)", next3.Format("2006-01-02 15:04 UTC"), next3.Sub(now).Round(time.Minute))
	log.Printf("   Next $30 test: %s (in %v)", next30.Format("2006-01-02 15:04 UTC"), next30.Sub(now).Round(time.Minute))
}

// Exec3Chan returns the channel that fires for $3 tests.
func (s *Scheduler) Exec3Chan() <-chan struct{} {
	return s.exec3Chan
}

// Exec30Chan returns the channel that fires for $30 tests.
func (s *Scheduler) Exec30Chan() <-chan struct{} {
	return s.exec30Chan
}

// Stop stops the scheduler.
func (s *Scheduler) Stop() {
	close(s.stopChan)
}

// run3USDScheduler runs $3 tests at scheduled hours daily.
func (s *Scheduler) run3USDScheduler() {
	for {
		now := time.Now().UTC()
		next := s.nextTime3USD(now)
		waitDuration := next.Sub(now)

		log.Printf("⏰ $3 test scheduled for %s (waiting %v)", next.Format("2006-01-02 15:04 UTC"), waitDuration.Round(time.Minute))

		select {
		case <-time.After(waitDuration):
			select {
			case s.exec3Chan <- struct{}{}:
				log.Println("🔔 $3 execution triggered")
			default:
				// Channel full, skip
			}
		case <-s.stopChan:
			return
		}
	}
}

// run30USDScheduler runs $30 tests on specific weekdays.
func (s *Scheduler) run30USDScheduler() {
	for {
		now := time.Now().UTC()
		next := s.nextTime30USD(now)
		waitDuration := next.Sub(now)

		log.Printf("⏰ $30 test scheduled for %s (waiting %v)", next.Format("2006-01-02 15:04 UTC"), waitDuration.Round(time.Minute))

		select {
		case <-time.After(waitDuration):
			select {
			case s.exec30Chan <- struct{}{}:
				log.Println("🔔 $30 execution triggered")
			default:
			}
		case <-s.stopChan:
			return
		}
	}
}

// nextTime3USD calculates the next $3 test time.
func (s *Scheduler) nextTime3USD(now time.Time) time.Time {
	for _, hour := range s.schedule.Hours3USD {
		candidate := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, time.UTC)
		if candidate.After(now) {
			return candidate
		}
	}
	tomorrow := now.AddDate(0, 0, 1)
	return time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), s.schedule.Hours3USD[0], 0, 0, 0, time.UTC)
}

// nextTime30USD calculates the next $30 test time.
func (s *Scheduler) nextTime30USD(now time.Time) time.Time {
	candidate := time.Date(now.Year(), now.Month(), now.Day(), s.schedule.Hour30USD, 0, 0, 0, time.UTC)

	if !candidate.After(now) {
		candidate = candidate.AddDate(0, 0, 1)
	}

	for i := 0; i < 7; i++ {
		for _, wd := range s.schedule.Weekdays30USD {
			if candidate.Weekday() == wd {
				return candidate
			}
		}
		candidate = candidate.AddDate(0, 0, 1)
	}

	return candidate
}
