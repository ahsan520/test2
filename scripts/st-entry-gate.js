// ═════════════════════════════════════════════════════════════════
// st-entry-gate.js — execution-time confirmation for ST5/ST15 priority buys
//
// Why: the priority path ("Normal BUY conditions bypassed") never consulted
// the conviction / flow columns the leaderboard shows. 2026-10-03 review:
// RENDER was bought on a RETEST of an EXHAUSTED 5m cross while CVD was down
// and conviction negative; the ST5 basket also had NEAR/DOGE/TAO/ZEC (all
// WEAK/AVOID) queued and was only stopped by a $0 wallet.
//
// Pure function (no I/O) so it is unit-testable. mexc-trader.js supplies
// the live price (fail-open if unavailable).
//
// Rules (each can be disabled via env):
//   1. CONV      — entry.conv must be >= ST_GATE_MIN_CONV (default 0)
//   2. SIGNAL    — signal must not be AVOID / WEAK / FALLING KNIFE
//   3. RETEST    — a buy that waited for a pullback (retestBuy) must not
//                  have CVD trending down (the pullback is still being sold)
//   4. FAILED    — a fresh (non-retest) buy must not have drifted more than
//                  ST_GATE_MAX_DRIFT_DOWN_PCT below the cross close (the
//                  breakout already failed). Skipped for retest buys, where
//                  a pullback toward the Supertrend line is expected.
// ST_GATE_MODE=log evaluates and audits but never blocks (paper-test it).
// ═════════════════════════════════════════════════════════════════

const num = (n, d) => parseFloat(process.env[n] ?? d);

export const ST_GATE_ENABLED   = (process.env.ST_GATE_ENABLE ?? 'true') !== 'false';
export const ST_GATE_MODE      = (process.env.ST_GATE_MODE || 'block').toLowerCase(); // 'block' | 'log'
const MIN_CONV        = num('ST_GATE_MIN_CONV', '0');
const MAX_DRIFT_DOWN  = num('ST_GATE_MAX_DRIFT_DOWN_PCT', '0.5');
const BAD_SIGNALS     = new Set(['AVOID', 'WEAK', 'FALLING KNIFE']);

export function checkPriorityEntryGate({ entry, event, retestBuy = false, livePrice = null }) {
  const reasons = [];
  const conv   = entry?.conv;
  const signal = entry?.signal ?? null;
  const cvd    = entry?.d?.cvdTrend ?? null;

  if (conv != null && !isNaN(conv) && conv < MIN_CONV) {
    reasons.push(`conviction ${conv} < ${MIN_CONV}`);
  }
  if (signal && BAD_SIGNALS.has(signal)) {
    reasons.push(`signal ${signal}`);
  }
  if (retestBuy && cvd === 'down') {
    reasons.push('retest buy while CVD still trending down');
  }
  const ref = parseFloat(event?.close);
  const lp  = parseFloat(livePrice);
  if (!retestBuy && ref > 0 && lp > 0) {
    const driftPct = (lp - ref) / ref * 100;
    if (driftPct < -MAX_DRIFT_DOWN) {
      reasons.push(`price ${driftPct.toFixed(2)}% below cross close (breakout failed, max -${MAX_DRIFT_DOWN}%)`);
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    snapshot: { conv: conv ?? null, signal, cvd, retestBuy, livePrice: lp || null, crossClose: ref || null },
  };
}

// ── Retest lateness cap + entry-timing record (added 2026-10-03 review) ──
// 2026-10-03: of ~8 ST5 crosses detected in a day, every one was already
// EXHAUSTED (2-3.2 ATR above the Supertrend line) at detection. The one fill
// (RENDER) came ~20 min after detection on a "retest" and closed -0.89%.
// ST5 trades flagged overextended averaged -0.09% vs +0.50% for the rest.
// A retest that only confirms long after the cross is no longer the same
// trade, so it is dropped. 0 disables the cap.
export const ST_RETEST_MAX_AGE_MIN = num('ST_RETEST_MAX_AGE_MIN', '15');
// An EXHAUSTED-zone retest buy is a lower-quality entry than a first-touch
// cross: size it down. 1 disables.
export const ST_RETEST_SIZE_MULT   = num('ST_RETEST_SIZE_MULT', '0.5');

// Minutes since the cross was detected (null if unknown).
export function eventAgeMin(event, nowMs = Date.now()) {
  const t = Date.parse(event?.detectedAt);
  return Number.isFinite(t) ? (nowMs - t) / 60000 : null;
}

// Snapshot written onto the trade-log entry at buy time so entry timing can be
// measured in the next review (the log previously had no entry-quality data).
export function buildEntryTiming({ event, retestBuy = false, fillPrice = null, nowMs = Date.now() }) {
  const atCross = event?.type === 'ST15_CROSS_UP' ? event?.st15AtCross : event?.st5AtCross;
  const age = eventAgeMin(event, nowMs);
  const ref = parseFloat(event?.close);
  const fp  = parseFloat(fillPrice);
  return {
    eventId:        event?.id ?? null,
    entryDelayMin:  age == null ? null : parseFloat(age.toFixed(1)),
    crossClose:     ref > 0 ? ref : null,
    fillVsCrossPct: (ref > 0 && fp > 0) ? parseFloat(((fp - ref) / ref * 100).toFixed(2)) : null,
    zone:           atCross?.extensionZone ?? null,
    distanceATR:    atCross?.distanceATR ?? null,
    retestBuy:      !!retestBuy,
  };
}
