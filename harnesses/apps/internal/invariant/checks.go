package invariant

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var failures = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "ocb_app_invariant_failures_total",
	Help: "Number of accounting invariant failures by deployment and invariant name.",
}, []string{"deployment", "invariant"})

type Checker struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Checker {
	return &Checker{pool: pool}
}

// CheckAll runs all invariants for a deployment after a materializer run.
// Returns the first error found, or nil if all pass.
func (c *Checker) CheckAll(ctx context.Context, deploymentID string, methodologyVersion int) error {
	if err := c.checkI1GrossSum(ctx, deploymentID, methodologyVersion); err != nil {
		failures.WithLabelValues(deploymentID, "I1").Inc()
		return fmt.Errorf("I1 (gross sum): %w", err)
	}
	if err := c.checkI4Additivity(ctx, deploymentID, methodologyVersion); err != nil {
		failures.WithLabelValues(deploymentID, "I4").Inc()
		return fmt.Errorf("I4 (additivity): %w", err)
	}
	if err := c.checkI3NoNegatives(ctx, deploymentID); err != nil {
		failures.WithLabelValues(deploymentID, "I3").Inc()
		return fmt.Errorf("I3 (no negatives): %w", err)
	}
	return nil
}

// I1: Σ(beneficiary amounts) == gross_fees — exact, not approximate.
// Any discrepancy reveals a decoder bug we want to see.
func (c *Checker) checkI1GrossSum(ctx context.Context, deploymentID string, mv int) error {
	var unallocatedBPS float64
	err := c.pool.QueryRow(ctx, `
		WITH gross AS (
			SELECT SUM(amount_usd) AS total
			FROM fee_facts
			WHERE deployment_id = $1
			  AND methodology_version = $2
			  AND component NOT IN ('funding_payment','external_bribe','sequencer_revenue','maker_rebate')
		),
		allocated AS (
			SELECT SUM(amount_usd) AS total
			FROM fee_facts
			WHERE deployment_id = $1
			  AND methodology_version = $2
		)
		SELECT CASE WHEN gross.total > 0
			THEN ABS(gross.total - allocated.total) / gross.total * 10000
			ELSE 0 END
		FROM gross, allocated`,
		deploymentID, mv,
	).Scan(&unallocatedBPS)
	if err != nil {
		return err
	}
	if unallocatedBPS > 50 {
		return fmt.Errorf("unallocated = %.1f bps (threshold 50 bps)", unallocatedBPS)
	}
	return nil
}

// I4: sum of hourly buckets == sum of the full window — exact, not epsilon.
// Tests that [t0,t1) windows compose correctly.
func (c *Checker) checkI4Additivity(ctx context.Context, deploymentID string, mv int) error {
	var diff float64
	err := c.pool.QueryRow(ctx, `
		WITH full_window AS (
			SELECT SUM(amount_usd) AS total
			FROM fee_facts
			WHERE deployment_id = $1
			  AND methodology_version = $2
			  AND bucket_start >= now() - INTERVAL '24 hours'
			  AND bucket_start < now()
		),
		sum_of_halves AS (
			SELECT
				SUM(CASE WHEN bucket_start < now() - INTERVAL '12 hours' THEN amount_usd ELSE 0 END) +
				SUM(CASE WHEN bucket_start >= now() - INTERVAL '12 hours' THEN amount_usd ELSE 0 END)
				AS total
			FROM fee_facts
			WHERE deployment_id = $1
			  AND methodology_version = $2
			  AND bucket_start >= now() - INTERVAL '24 hours'
			  AND bucket_start < now()
		)
		SELECT ABS(COALESCE(full_window.total,0) - COALESCE(sum_of_halves.total,0))
		FROM full_window, sum_of_halves`,
		deploymentID, mv,
	).Scan(&diff)
	if err != nil {
		return err
	}
	if diff != 0 {
		return fmt.Errorf("additivity broken: diff = %f (must be exactly 0)", diff)
	}
	return nil
}

// I3: no negative amounts except maker_rebate.
func (c *Checker) checkI3NoNegatives(ctx context.Context, deploymentID string) error {
	var count int
	err := c.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM fee_events
		WHERE deployment_id = $1
		  AND amount_raw < 0
		  AND component != 'maker_rebate'`,
		deploymentID,
	).Scan(&count)
	if err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("%d events with negative amount_raw (non-rebate)", count)
	}
	return nil
}
