/**
 * Shared time-unit constants.
 *
 * Single source of truth for the seconds conversions that leak across
 * files as magic numbers (86400, 60, 3600). Importing from here makes
 * the intent obvious at the call site and keeps grep-ability if a
 * duration unit ever has to change.
 */

export const MS_PER_SECOND = 1_000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;
