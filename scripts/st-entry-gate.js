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

// Market/coin context at the moment of the buy, stored with the trade so the
// RSI, breadth, conviction and gate cutoffs can be tuned against real results
// (the trade log previously had none of this). Pure — never throws.
export function buildEntryContext({ entry, market, marketState }) {
  const r = (v, n = 1) => (v == null || isNaN(v)) ? null : parseFloat(Number(v).toFixed(n));
  const d = entry?.d || {};
  return {
    conv:       entry?.conv ?? null,
    rawConv:    entry?.rawConv ?? null,
    signal:     entry?.signal ?? null,
    entryState: entry?.entryState ?? null,
    bullConf:   entry?.bullConf ?? null,
    grade:      entry?.grade ?? null,
    whale:      entry?.whale?.score ?? null,
    r15:        r(d.r15),
    r1h:        r(d.r1h),
    cvd:        d.cvdTrend ?? null,
    breadth:    marketState?.breadth?.score ?? null,
    regime:     typeof marketState?.marketRegime === 'string' ? marketState.marketRegime : null,
    btcRisk:    marketState?.btcRiskScore ?? null,
    btcBias4h:  market?.global?.btcBias4h ?? null,
  };
}

// ── Spike-breakout exception (OFF by default) ───────────────────────────
// Problem (2026-10-04 SUI): a coin breaks out of a flat range on expanding
// volume; the impulse candle itself pushes RSI past the overextension cutoff
// (RSI >= 70 / 1h >= 68) and the cross is already EXHAUSTED, so the bot
// skips it or waits for a retest that never comes. The existing broad-rally
// override needs breadth >= 85, which a single-coin spike never produces.
// This lets a cross through BOTH barriers only when the coin's own tape
// confirms a real breakout (not a late trend candle):
//   confirmed breakout (trigger BREAKOUT / range break) AND volume expansion
//   AND CVD rising AND RSI not absurd AND distance from the line capped
//   AND conviction/signal not weak.
// Such buys are sized down (ST_BO_SIZE_MULT) and use the wider overextended
// stop. Unproven on live data: keep disabled until the entry-context log
// (or missed_signal_check.py) shows these entries pay.
export const ST_BO_ENABLE    = (process.env.ST_BO_ENABLE ?? 'false') === 'true';
export const ST_BO_SIZE_MULT = num('ST_BO_SIZE_MULT', '0.5');
const BO_MAX_ATR   = num('ST_BO_MAX_ATR', '4.5');
const BO_MAX_RSI15 = num('ST_BO_MAX_RSI15', '84');

export function checkSpikeBreakout({ entry, event, tf = '5' }) {
  if (!ST_BO_ENABLE) return { ok: false, disabled: true, failed: [], snapshot: null };
  const st = tf === '15'
    ? (event?.st15AtCross || entry?.supertrend15m)
    : (event?.st5AtCross  || entry?.supertrend5m);
  const failed = [];

  const breakout = entry?.triggerStatus === 'BREAKOUT'
    || entry?.breakoutConfirmed === true
    || st?.consolidation?.breakout === true;
  if (!breakout) failed.push('no confirmed breakout from a range');
  if (entry?.bullChecks?.volExpansion !== true) failed.push('no volume expansion');
  if (entry?.d?.cvdTrend !== 'up') failed.push('CVD not rising');

  const r15 = entry?.d?.r15;
  if (r15 != null && r15 > BO_MAX_RSI15) failed.push(`RSI ${r15} > ${BO_MAX_RSI15}`);
  const dist = st?.distanceATR;
  if (dist != null && dist > BO_MAX_ATR) failed.push(`${dist} ATR from the line > ${BO_MAX_ATR}`);

  if (entry?.conv != null && entry.conv < MIN_CONV) failed.push(`conviction ${entry.conv} < ${MIN_CONV}`);
  if (entry?.signal && BAD_SIGNALS.has(entry.signal)) failed.push(`signal ${entry.signal}`);

  return {
    ok: failed.length === 0, failed,
    snapshot: { breakout, vol: entry?.bullChecks?.volExpansion ?? null, cvd: entry?.d?.cvdTrend ?? null, r15: r15 ?? null, distanceATR: dist ?? null },
  };
}

// ── Minimum priority-buy size ─────────────────────────────────────────────
// 2026-10-04: with the wallet already deployed in two flat positions, an ST5
// cross sized itself from the ~$5 left over and opened a $5.37 GALA position.
// It earned nothing, could not be partially sold (below MEXC's $5 minimum),
// and held one of the three concurrent slots for two hours. Below this size a
// priority buy is skipped instead. 0 disables.
export const ST_MIN_BUY_USD = num('ST_MIN_BUY_USD', '100');
