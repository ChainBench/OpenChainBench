package main

import (
	"log"
	"time"
)

// Schedule defines when execution tests run
// Uses fixed UTC times so redeploys don't affect the rhythm
type Schedule struct {
	// $5 tests: daily at these hours UTC
	Hours5USD []int // e.g., [10] = 10:00 UTC daily

	// $50 tests: specific weekdays at hour UTC
	// 0=Sunday, 1=Monday, ..., 6=Saturday
	Weekdays50USD []time.Weekday
	Hour50USD     int

	// $300 tests: specific weekdays at hour UTC (Option C — weekly rhythm so
	// stats converge in ~6 weeks instead of 6 months vs the monthly cadence).
	Weekdays300USD []time.Weekday
	Hour300USD     int
}

// DefaultSchedule returns the default execution schedule
// $5:   daily at 10:00 UTC
// $50:  Monday & Thursday at 10:00 UTC
// $300: Monday at 10:00 UTC (weekly)
func DefaultSchedule() *Schedule {
	return &Schedule{
		Hours5USD:      []int{10}, // 10:00 UTC daily
		Weekdays50USD:  []time.Weekday{time.Monday, time.Thursday},
		Hour50USD:      10,
		Weekdays300USD: []time.Weekday{time.Monday},
		Hour300USD:     10,
	}
}

// Scheduler handles fixed-time execution scheduling
type Scheduler struct {
	schedule    *Schedule
	exec5Chan   chan struct{}
	exec50Chan  chan struct{}
	exec300Chan chan struct{}
	stopChan    chan struct{}
}

// NewScheduler creates a new scheduler with fixed times
func NewScheduler(schedule *Schedule) *Scheduler {
	if schedule == nil {
		schedule = DefaultSchedule()
	}
	return &Scheduler{
		schedule:    schedule,
		exec5Chan:   make(chan struct{}, 1),
		exec50Chan:  make(chan struct{}, 1),
		exec300Chan: make(chan struct{}, 1),
		stopChan:    make(chan struct{}),
	}
}

// Start begins the scheduler goroutines
func (s *Scheduler) Start() {
	log.Println("📅 Scheduler started with fixed UTC times:")
	log.Printf("   $5 tests:   daily at %v:00 UTC", s.schedule.Hours5USD)
	log.Printf("   $50 tests:  %v at %02d:00 UTC", s.schedule.Weekdays50USD, s.schedule.Hour50USD)
	log.Printf("   $300 tests: %v at %02d:00 UTC", s.schedule.Weekdays300USD, s.schedule.Hour300USD)

	// Log next scheduled times
	s.logNextScheduledTimes()

	go s.run5USDScheduler()
	go s.run50USDScheduler()
	go s.run300USDScheduler()
}

// logNextScheduledTimes logs when the next tests will run
func (s *Scheduler) logNextScheduledTimes() {
	now := time.Now().UTC()

	next5 := s.nextTime5USD(now)
	next50 := s.nextTime50USD(now)
	next300 := s.nextTime300USD(now)

	log.Printf("   Next $5 test:   %s (in %v)", next5.Format("2006-01-02 15:04 UTC"), next5.Sub(now).Round(time.Minute))
	log.Printf("   Next $50 test:  %s (in %v)", next50.Format("2006-01-02 15:04 UTC"), next50.Sub(now).Round(time.Minute))
	log.Printf("   Next $300 test: %s (in %v)", next300.Format("2006-01-02 15:04 UTC"), next300.Sub(now).Round(time.Minute))
}

// Exec5Chan returns the channel that fires for $5 tests
func (s *Scheduler) Exec5Chan() <-chan struct{} {
	return s.exec5Chan
}

// Exec50Chan returns the channel that fires for $50 tests
func (s *Scheduler) Exec50Chan() <-chan struct{} {
	return s.exec50Chan
}

// Exec300Chan returns the channel that fires for $300 tests
func (s *Scheduler) Exec300Chan() <-chan struct{} {
	return s.exec300Chan
}

// Stop stops the scheduler
func (s *Scheduler) Stop() {
	close(s.stopChan)
}

// run5USDScheduler runs $5 tests at scheduled hours daily
func (s *Scheduler) run5USDScheduler() {
	for {
		now := time.Now().UTC()
		next := s.nextTime5USD(now)
		waitDuration := next.Sub(now)

		log.Printf("⏰ $5 test scheduled for %s (waiting %v)", next.Format("2006-01-02 15:04 UTC"), waitDuration.Round(time.Minute))

		select {
		case <-time.After(waitDuration):
			select {
			case s.exec5Chan <- struct{}{}:
				log.Println("🔔 $5 execution triggered")
			default:
				// Channel full, skip
			}
		case <-s.stopChan:
			return
		}
	}
}

// run50USDScheduler runs $50 tests on specific weekdays
func (s *Scheduler) run50USDScheduler() {
	for {
		now := time.Now().UTC()
		next := s.nextTime50USD(now)
		waitDuration := next.Sub(now)

		log.Printf("⏰ $50 test scheduled for %s (waiting %v)", next.Format("2006-01-02 15:04 UTC"), waitDuration.Round(time.Minute))

		select {
		case <-time.After(waitDuration):
			select {
			case s.exec50Chan <- struct{}{}:
				log.Println("🔔 $50 execution triggered")
			default:
			}
		case <-s.stopChan:
			return
		}
	}
}

// run300USDScheduler runs $300 tests on specific weekdays
func (s *Scheduler) run300USDScheduler() {
	for {
		now := time.Now().UTC()
		next := s.nextTime300USD(now)
		waitDuration := next.Sub(now)

		log.Printf("⏰ $300 test scheduled for %s (waiting %v)", next.Format("2006-01-02 15:04 UTC"), waitDuration.Round(time.Minute))

		select {
		case <-time.After(waitDuration):
			select {
			case s.exec300Chan <- struct{}{}:
				log.Println("🔔 $300 execution triggered")
			default:
			}
		case <-s.stopChan:
			return
		}
	}
}

// nextTime5USD calculates the next $5 test time
func (s *Scheduler) nextTime5USD(now time.Time) time.Time {
	// Find the next scheduled hour today or tomorrow
	for _, hour := range s.schedule.Hours5USD {
		candidate := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, time.UTC)
		if candidate.After(now) {
			return candidate
		}
	}
	// All hours passed today, try first hour tomorrow
	tomorrow := now.AddDate(0, 0, 1)
	return time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), s.schedule.Hours5USD[0], 0, 0, 0, time.UTC)
}

// nextTime50USD calculates the next $50 test time
func (s *Scheduler) nextTime50USD(now time.Time) time.Time {
	// Start from today
	candidate := time.Date(now.Year(), now.Month(), now.Day(), s.schedule.Hour50USD, 0, 0, 0, time.UTC)

	// If today's time has passed, start from tomorrow
	if !candidate.After(now) {
		candidate = candidate.AddDate(0, 0, 1)
	}

	// Find next matching weekday
	for i := 0; i < 7; i++ {
		for _, wd := range s.schedule.Weekdays50USD {
			if candidate.Weekday() == wd {
				return candidate
			}
		}
		candidate = candidate.AddDate(0, 0, 1)
	}

	return candidate
}

// nextTime300USD calculates the next $300 test time (weekly weekday-based)
func (s *Scheduler) nextTime300USD(now time.Time) time.Time {
	candidate := time.Date(now.Year(), now.Month(), now.Day(), s.schedule.Hour300USD, 0, 0, 0, time.UTC)

	if !candidate.After(now) {
		candidate = candidate.AddDate(0, 0, 1)
	}

	for i := 0; i < 7; i++ {
		for _, wd := range s.schedule.Weekdays300USD {
			if candidate.Weekday() == wd {
				return candidate
			}
		}
		candidate = candidate.AddDate(0, 0, 1)
	}

	return candidate
}
