/**
 * Shared time-unit constants.
 *
 * Single source of truth for the milliseconds / seconds conversions that
 * leak across files as magic numbers (86400, 60_000, 3_600_000, ...).
 * Importing from here makes the intent obvious at the call site and
 * keeps grep-ability if a duration unit ever has to change.
 *
 * Naming convention mirrors the unit-of-measure that the constant
 * EXPANDS into (MS_PER_MINUTE === 60_000 milliseconds in one minute).
 */

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
