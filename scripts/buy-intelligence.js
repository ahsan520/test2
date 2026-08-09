// ══════════════════════════════════════════════════════════════════════════════
// buy-intelligence.js — Buy Intelligence (entry-timing checks)
//
// Position Intelligence protects losing trades by catching a broken thesis.
// Profit Intelligence protects winning trades from giving profit back. Both
// only ever see whatever already got bought — neither can fix a trade that
// was extended or already turning the moment it entered.
//
// This module is the entry-side counterpart: independent, additive checks
// that run BEFORE a buy, mirroring the same "own module, own reasons,
// doesn't touch the existing score" pattern as profit-intelligence.js.
//
// Checks aimed at trade-log patterns:
//   1. RSI extension — independent per-timeframe scoring (15m / 1h).
//   2. Candle-run chasing — consecutive green 15m candles streak check.
//   3. Signal quality floor — filters thin setups with low confidence.
//   4. Pullback from high — prevents buying into active breakdowns.
//   5. Time-of-Day (ToD) liquidity — penalizes low-volume / high-wick
//      off-hours window (5 PM - 2 AM EST) and raises the quality floor.
// ══════════════════════════════════════════════════════════════════════════════

const CHASE_ENABLED = (process.env.BUY_ENABLE_CHASE_CHECK || 'true') !== 'false';
const CHASE_WARN_STREAK  = parseInt(process.env.BUY_CHASE_WARN_STREAK  || '2', 10); // consecutive green 15m candles -> -1
const CHASE_BLOCK_STREAK = parseInt(process.env.BUY_CHASE_BLOCK_STREAK || '3', 10); // -> -2

const RSI_ENABLED = (process.env.BUY_ENABLE_RSI_EXTENSION_CHECK || 'true') !== 'false';
const RSI_15M_HOT  = parseFloat(process.env.BUY_RSI_15M_HOT  || '70'); // matches bullConf's existing rsiNotOb line
const RSI_15M_VHOT = parseFloat(process.env.BUY_RSI_15M_VHOT || '78');
const RSI_1H_HOT   = parseFloat(process.env.BUY_RSI_1H_HOT   || '68');

const QUALITY_ENABLED = (process.env.BUY_ENABLE_QUALITY_FLOOR || 'true') !== 'false';
const QUALITY_MIN_BULLCONF = parseInt(process.env.BUY_QUALITY_MIN_BULLCONF || '3', 10); // out of 10
const QUALITY_MIN_WHALE    = parseFloat(process.env.BUY_QUALITY_MIN_WHALE  || '40');    // out of 100

// Dynamic off-hours quality floor overrides (5 PM - 2 AM EST)
const QUALITY_OFFHOURS_MIN_BULLCONF = parseInt(process.env.BUY_QUALITY_OFFHOURS_MIN_BULLCONF || '5', 10);
const QUALITY_OFFHOURS_MIN_WHALE    = parseFloat(process.env.BUY_QUALITY_OFFHOURS_MIN_WHALE  || '60');

const PULLBACK_ENABLED = (process.env.BUY_ENABLE_PULLBACK_CHECK || 'true') !== 'false';
const PULLBACK_LOOKBACK  = parseInt(process.env.BUY_PULLBACK_LOOKBACK  || '10', 10); // closed 15m candles to scan for the recent high
const PULLBACK_WARN_PCT  = parseFloat(process.env.BUY_PULLBACK_WARN_PCT  || '0.5');
const PULLBACK_BLOCK_PCT = parseFloat(process.env.BUY_PULLBACK_BLOCK_PCT || '1.0');

// Time-of-day settings
const TOD_ENABLED = (process.env.BUY_ENABLE_TOD_CHECK || 'true') !== 'false';
const TOD_PENALTY = parseInt(process.env.BUY_TOD_PENALTY || '1', 10);

// ── Candle-run "chasing" check ──────────────────────────────────────────
export function calcEntryFreshness(k15) {
  if (!CHASE_ENABLED || !Array.isArray(k15) || k15.length < 4) {
    return { consecutiveUp: 0, consecutiveDown: 0, chasing: false, penalty: 0, reason: null };
  }
  const closed  = k15.slice(0, -1); // drop the still-forming current candle
  const closes  = closed.map(c => parseFloat(c[4]));
  const opens   = closed.map(c => parseFloat(c[1]));

  let consecutiveUp = 0;
  for (let i = closes.length - 1; i >= 0 && closes[i] > opens[i]; i--) consecutiveUp++;
  let consecutiveDown = 0;
  for (let i = closes.length - 1; i >= 0 && closes[i] < opens[i]; i--) consecutiveDown++;

  let penalty = 0, reason = null;
  if (consecutiveUp >= CHASE_BLOCK_STREAK) {
    penalty = 2;
    reason = `${consecutiveUp} straight green 15m candles — buying deep into an already-extended move`;
  } else if (consecutiveUp >= CHASE_WARN_STREAK) {
    penalty = 1;
    reason = `${consecutiveUp} straight green 15m candles — move is already underway, not fresh`;
  }

  return { consecutiveUp, consecutiveDown, chasing: penalty > 0, penalty, reason };
}

// ── RSI extension check ─────────────────────────────────────────────────
export function calcEntryExtension(r15, r1h) {
  if (!RSI_ENABLED) return { penalty: 0, reason: null };
  const r15v = r15 ?? 50, r1hv = r1h ?? 50;

  let penalty = 0;
  const hits = [];
  if (r15v >= RSI_15M_VHOT)     { penalty += 2; hits.push(`15m RSI ${r15v.toFixed(0)} ≥ ${RSI_15M_VHOT} (very extended)`); }
  else if (r15v >= RSI_15M_HOT) { penalty += 1; hits.push(`15m RSI ${r15v.toFixed(0)} ≥ ${RSI_15M_HOT}`); }
  if (r1hv >= RSI_1H_HOT)       { penalty += 1; hits.push(`1h RSI ${r1hv.toFixed(0)} ≥ ${RSI_1H_HOT}`); }

  return { penalty, reason: hits.length ? hits.join(' · ') : null };
}

// ── Signal-quality / data-confidence floor ─────────────────────────────
// Supports optional isOffHours flag to enforce higher signal thresholds
// during thin order-book windows (5 PM - 2 AM EST).
export function calcSignalQuality(bullConfCount, whaleScore, isOffHours = false) {
  if (!QUALITY_ENABLED || bullConfCount == null || whaleScore == null) {
    return { penalty: 0, reason: null };
  }

  const minBull = isOffHours ? QUALITY_OFFHOURS_MIN_BULLCONF : QUALITY_MIN_BULLCONF;
  const minWhale = isOffHours ? QUALITY_OFFHOURS_MIN_WHALE : QUALITY_MIN_WHALE;

  const hits = [];
  let penalty = 0;
  if (bullConfCount < minBull) {
    penalty += 2;
    hits.push(`bullConf ${bullConfCount}/10 < ${minBull} (${isOffHours ? 'off-hours strict' : 'thin signal'})`);
  }
  if (whaleScore < minWhale) {
    penalty += 1;
    hits.push(`whale ${whaleScore}/100 < ${minWhale} (${isOffHours ? 'off-hours strict' : 'low confidence'})`);
  }
  return { penalty, reason: hits.length ? hits.join(' · ') : null };
}

// ── Pullback-from-recent-high check ─────────────────────────────────────
export function calcPullbackFromHigh(k15, currentPrice) {
  if (!PULLBACK_ENABLED || !Array.isArray(k15) || k15.length < PULLBACK_LOOKBACK + 1 || currentPrice == null) {
    return { penalty: 0, reason: null, pullbackPct: 0, recentHigh: null };
  }
  const closed = k15.slice(0, -1).slice(-PULLBACK_LOOKBACK);
  const recentHigh = Math.max(...closed.map(c => parseFloat(c[2]))); // index 2 = candle high
  if (!isFinite(recentHigh) || recentHigh <= 0) {
    return { penalty: 0, reason: null, pullbackPct: 0, recentHigh: null };
  }
  const pullbackPct = ((recentHigh - currentPrice) / recentHigh) * 100;

  let penalty = 0, reason = null;
  if (pullbackPct >= PULLBACK_BLOCK_PCT) {
    penalty = 2;
    reason = `${pullbackPct.toFixed(2)}% below the ${PULLBACK_LOOKBACK}-candle high — buying into an active breakdown, not a dip`;
  } else if (pullbackPct >= PULLBACK_WARN_PCT) {
    penalty = 1;
    reason = `${pullbackPct.toFixed(2)}% below the ${PULLBACK_LOOKBACK}-candle high — price already rolled over from a recent top`;
  }
  return { penalty, reason, pullbackPct: parseFloat(pullbackPct.toFixed(3)), recentHigh };
}

// ── Time-of-Day / Off-Hours Liquidity Check ─────────────────────────────
// Evaluates if the trigger falls in the low-liquidity / wick-heavy transition
// window between 5:00 PM EST (17:00) and 2:00 AM EST (02:00).
export function calcTimeOfDayPenalty(date = new Date()) {
  if (!TOD_ENABLED) return { penalty: 0, reason: null, isOffHours: false };

  const estHour = parseInt(
    date.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }),
    10
  );

  const isOffHours = estHour >= 17 || estHour < 2;

  if (isOffHours) {
    return {
      penalty: TOD_PENALTY,
      reason: `Triggered during off-hours window (5 PM - 2 AM EST) — elevated low-liquidity / wick risk`,
      isOffHours: true
    };
  }

  return { penalty: 0, reason: null, isOffHours: false };
}

// ── Combined entry check — called once per symbol from scoreSymbol() ──
export function evaluateBuyReadiness({ r15, r1h, k15, bullConfCount, whaleScore, currentPrice, timestamp }) {
  const tod       = calcTimeOfDayPenalty(timestamp ? new Date(timestamp) : new Date());
  const freshness = calcEntryFreshness(k15);
  const extension = calcEntryExtension(r15, r1h);
  const quality   = calcSignalQuality(bullConfCount, whaleScore, tod.isOffHours);
  const pullback  = calcPullbackFromHigh(k15, currentPrice);

  const penalty = freshness.penalty + extension.penalty + quality.penalty + pullback.penalty + tod.penalty;
  const reasons = [freshness.reason, extension.reason, quality.reason, pullback.reason, tod.reason].filter(Boolean);

  return { penalty, reasons, freshness, extension, quality, pullback, tod };
}