// Single source for ISO week strings, e.g. "2026-W26".
//
// All scoring, leaderboard filtering and the weekly post key off this. Keeping it in
// one place means the week boundary is defined exactly once. ISO 8601 weeks start on
// Monday and week 1 is the week containing the first Thursday of the year.

// Returns the ISO week string for a given Date (defaults to now), computed in UTC.
export function isoWeek(date = new Date()) {
  const { year, week } = isoWeekParts(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Returns { year, week } where year is the ISO week-numbering year (which can differ
// from the calendar year for days near January 1st).
export function isoWeekParts(date = new Date()) {
  // Work on a UTC copy so DST and local tz never shift the week boundary.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  // ISO weekday: Mon=1 .. Sun=7.
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();

  // Shift to the Thursday of this week: the Thursday determines the year+week.
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);

  return { year: isoYear, week };
}

// The ISO week immediately before the given date's week. Used by the weekly post,
// which runs just after a week rolls over and reports the week that just ended.
export function previousIsoWeek(date = new Date()) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() - 7);
  return isoWeek(d);
}
