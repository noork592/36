// Date helpers — all factory ledgers / reports group by India Standard Time
// (UTC+5:30), so "today" must be the IST calendar day even when the browser's
// clock is past midnight UTC. `new Date().toISOString()` always returns UTC,
// which off-by-one'd date pickers between 18:30 and 24:00 UTC (= 00:00–05:30
// next day in IST).

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** YYYY-MM-DD of today in IST (the factory's local clock). */
export function todayIso() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD of N days ago in IST. */
export function isoDaysAgo(n) {
  return new Date(Date.now() + IST_OFFSET_MS - n * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}
