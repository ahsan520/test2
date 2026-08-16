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
//   2. Candle-run chasing — consecutive green 15m candles, but only
//      penalized once RSI confirms the move is actually overbought, not
//      just "underway" — a fresh spike (RSI still has room) and an
//      exhausted one (RSI already hot) can share the same candle count.
//   3. Falling-knife — consecutive RED 15m candles; buying while price is
//      still actively falling, distinct from #4's magnitude-based check.
//   4. Signal quality floor — filters thin setups with low confidence.
//   5. Pullback from high — how far price has already fallen (magnitude,
//      can be stale/stabilized), complements #3's momentum-based check.
//   6. Time-of-Day (ToD) liquidity — penalizes low-volume / high-wick
//      off-hours window (5 PM - 2 AM EST) and raises the quality floor.
// ══════════════════════════════════════════════════════════════════════════════

const CHASE_ENABLED = (process.env.BUY_ENABLE_CHASE_CHECK || 'true') !== 'false';
const CHASE_WARN_STREAK  = parseInt(process.env.BUY_CHASE_WARN_STREAK  || '2', 10); // consecutive green 15m candles -> -1
const CHASE_BLOCK_STREAK = parseInt(process.env.BUY_CHASE_BLOCK_STREAK || '3', 10); // -> -2

// Falling-knife check — same candle-streak mechanics as the chase check,
// but on consecutiveDown instead of consecutiveUp. consecutiveDown was
// already being calculated below and simply never used for anything.
// Distinct from calcPullbackFromHigh: pullback measures HOW FAR price has
// already fallen from a recent high (magnitude, can be stale/stabilized);
// this measures whether it's STILL actively falling RIGHT NOW (momentum).
// A DIP BUY setup buying 1.2% below a recent high after price already
// stabilized should pass pullback but this checks the live candle streak
// regardless of setup type — buying while red candles are still stacking
// is the literal definition of catching a falling knife.
const KNIFE_ENABLED = (process.env.BUY_ENABLE_FALLING_KNIFE_CHECK || 'true') !== 'false';
const KNIFE_WARN_STREAK  = parseInt(process.env.BUY_FALLING_KNIFE_WARN_STREAK  || '2', 10);
const KNIFE_BLOCK_STREAK = parseInt(process.env.BUY_FALLING_KNIFE_BLOCK_STREAK || '3', 10);

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
// r15 is now REQUIRED context, not optional — a streak alone can't tell a
// fresh spike from an exhausted one. Same candle count, opposite meaning:
// consecutiveUp=2 with RSI15=48 is a breakout just getting started, still
// plenty of room to run. consecutiveUp=2 with RSI15=74 is the same streak
// on a move that's already overbought — genuinely chasing. Gating the
// penalty on RSI still being below RSI_15M_HOT means a fresh spike no
// longer eats the same penalty as a stale one just for having the same
// candle count.
export function calcEntryFreshness(k15, r15 = null, opts = {}) {
  const chaseWarnStreak  = opts.chaseWarnStreak  ?? CHASE_WARN_STREAK;
  const chaseBlockStreak = opts.chaseBlockStreak ?? CHASE_BLOCK_STREAK;
  const knifeWarnStreak  = opts.knifeWarnStreak  ?? KNIFE_WARN_STREAK;
  const knifeBlockStreak = opts.knifeBlockStreak ?? KNIFE_BLOCK_STREAK;
  const rsiHot           = opts.rsiHot           ?? RSI_15M_HOT;

  if (!CHASE_ENABLED || !Array.isArray(k15) || k15.length < 4) {
    return { consecutiveUp: 0, consecutiveDown: 0, chasing: false, penalty: 0, reason: null, knifePenalty: 0, knifeReason: null };
  }
  const closed  = k15.slice(0, -1); // drop the still-forming current candle
  const closes  = closed.map(c => parseFloat(c[4]));
  const opens   = closed.map(c => parseFloat(c[1]));

  let consecutiveUp = 0;
  for (let i = closes.length - 1; i >= 0 && closes[i] > opens[i]; i--) consecutiveUp++;
  let consecutiveDown = 0;
  for (let i = closes.length - 1; i >= 0 && closes[i] < opens[i]; i--) consecutiveDown++;

  const r15v = r15 ?? 50;
  const stillFresh = r15v < rsiHot; // room left to run — not yet confirmed overbought

  let penalty = 0, reason = null;
  if (consecutiveUp >= chaseBlockStreak && !stillFresh) {
    penalty = 2;
    reason = `${consecutiveUp} straight green candles with RSI ${r15v.toFixed(0)} already hot — buying deep into an already-extended move, not a fresh spike`;
  } else if (consecutiveUp >= chaseWarnStreak && !stillFresh) {
    penalty = 1;
    reason = `${consecutiveUp} straight green candles with RSI ${r15v.toFixed(0)} already hot — move is losing freshness`;
  }
  // else: streak exists but RSI still has room — treated as a fresh spike
  // starting, not chasing. No penalty, deliberately.

  let knifePenalty = 0, knifeReason = null;
  if (KNIFE_ENABLED) {
    if (consecutiveDown >= knifeBlockStreak) {
      knifePenalty = 2;
      knifeReason = `${consecutiveDown} straight red candles — still actively falling, not a stabilized dip`;
    } else if (consecutiveDown >= knifeWarnStreak) {
      knifePenalty = 1;
      knifeReason = `${consecutiveDown} straight red candles — momentum still pointing down`;
    }
  }

  return { consecutiveUp, consecutiveDown, chasing: penalty > 0, penalty, reason, knifePenalty, knifeReason };
}

// ── RSI extension check ─────────────────────────────────────────────────
export function calcEntryExtension(r15, r1h, opts = {}) {
  const rsi15Hot  = opts.rsi15Hot  ?? RSI_15M_HOT;
  const rsi15VHot = opts.rsi15VHot ?? RSI_15M_VHOT;
  const rsi1hHot  = opts.rsi1hHot  ?? RSI_1H_HOT;

  if (!RSI_ENABLED) return { penalty: 0, reason: null };
  const r15v = r15 ?? 50, r1hv = r1h ?? 50;

  let penalty = 0;
  const hits = [];
  if (r15v >= rsi15VHot)     { penalty += 2; hits.push(`RSI ${r15v.toFixed(0)} ≥ ${rsi15VHot} (very extended)`); }
  else if (r15v >= rsi15Hot) { penalty += 1; hits.push(`RSI ${r15v.toFixed(0)} ≥ ${rsi15Hot}`); }
  if (r1hv >= rsi1hHot)      { penalty += 1; hits.push(`confirming-timeframe RSI ${r1hv.toFixed(0)} ≥ ${rsi1hHot}`); }

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
export function calcPullbackFromHigh(k15, currentPrice, opts = {}) {
  const lookback = opts.lookback ?? PULLBACK_LOOKBACK;
  const warnPct  = opts.warnPct  ?? PULLBACK_WARN_PCT;
  const blockPct = opts.blockPct ?? PULLBACK_BLOCK_PCT;

  if (!PULLBACK_ENABLED || !Array.isArray(k15) || k15.length < lookback + 1 || currentPrice == null) {
    return { penalty: 0, reason: null, pullbackPct: 0, recentHigh: null };
  }
  const closed = k15.slice(0, -1).slice(-lookback);
  const recentHigh = Math.max(...closed.map(c => parseFloat(c[2]))); // index 2 = candle high
  if (!isFinite(recentHigh) || recentHigh <= 0) {
    return { penalty: 0, reason: null, pullbackPct: 0, recentHigh: null };
  }
  const pullbackPct = ((recentHigh - currentPrice) / recentHigh) * 100;

  let penalty = 0, reason = null;
  if (pullbackPct >= blockPct) {
    penalty = 2;
    reason = `${pullbackPct.toFixed(2)}% below the ${lookback}-period high — buying into an active breakdown, not a dip`;
  } else if (pullbackPct >= warnPct) {
    penalty = 1;
    reason = `${pullbackPct.toFixed(2)}% below the ${lookback}-period high — price already rolled over from a recent top`;
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
  const freshness = calcEntryFreshness(k15, r15);
  const extension = calcEntryExtension(r15, r1h);
  const quality   = calcSignalQuality(bullConfCount, whaleScore, tod.isOffHours);
  const pullback  = calcPullbackFromHigh(k15, currentPrice);

  const penalty = freshness.penalty + freshness.knifePenalty + extension.penalty + quality.penalty + pullback.penalty + tod.penalty;
  const reasons = [freshness.reason, freshness.knifeReason, extension.reason, quality.reason, pullback.reason, tod.reason].filter(Boolean);

  return { penalty, reasons, freshness, extension, quality, pullback, tod };
}

// ── Stock-calibrated entry check — called from scoreStock() ────────────────
// Reuses the SAME underlying check functions as evaluateBuyReadiness above
// (same math, same reasoning), but with its own thresholds calibrated for
// DAILY bars instead of 15m candles. "2 consecutive up periods" means two
// entire days for a stock, not 30 minutes — treating that as equivalent to
// crypto's chase threshold would either never fire (if left at crypto's
// tight streak counts, which are trivially exceeded by any stock in a
// short rally) or fire on totally ordinary week-to-week movement. Pullback
// percentages are similarly rescaled: equities routinely move 2-4% off a
// recent high without it meaning anything, where the same magnitude in
// crypto (calibrated at 0.5-1.0%) would already be a real signal.
//
// No time-of-day check here — that's specifically about crypto's 24/7
// off-hours liquidity window (5 PM - 2 AM EST thinness); it doesn't map to
// anything meaningful for exchange-hours equities without building actual
// market-hours-aware logic, which is out of scope here.
const STOCK_CHASE_WARN_STREAK   = parseInt(process.env.BUY_STOCK_CHASE_WARN_STREAK   || '2', 10); // days
const STOCK_CHASE_BLOCK_STREAK  = parseInt(process.env.BUY_STOCK_CHASE_BLOCK_STREAK  || '3', 10);
const STOCK_KNIFE_WARN_STREAK   = parseInt(process.env.BUY_STOCK_FALLING_KNIFE_WARN_STREAK  || '2', 10);
const STOCK_KNIFE_BLOCK_STREAK  = parseInt(process.env.BUY_STOCK_FALLING_KNIFE_BLOCK_STREAK || '3', 10);
const STOCK_RSI_HOT             = parseFloat(process.env.BUY_STOCK_RSI_HOT  || '70'); // classic equity overbought convention
const STOCK_RSI_VHOT            = parseFloat(process.env.BUY_STOCK_RSI_VHOT || '80');
const STOCK_RSI_CONFIRM_HOT     = parseFloat(process.env.BUY_STOCK_RSI_CONFIRM_HOT || '70'); // r1h proxy (30-day RSI window in scoreStock)
const STOCK_PULLBACK_LOOKBACK   = parseInt(process.env.BUY_STOCK_PULLBACK_LOOKBACK || '5', 10); // trading days (~1 week)
const STOCK_PULLBACK_WARN_PCT   = parseFloat(process.env.BUY_STOCK_PULLBACK_WARN_PCT  || '2.0');
const STOCK_PULLBACK_BLOCK_PCT  = parseFloat(process.env.BUY_STOCK_PULLBACK_BLOCK_PCT || '4.0');

export function evaluateStockBuyReadiness({ r15, r1h, bars, bullConfCount, whaleScore, currentPrice }) {
  // Reformat {c,o,h,l,v} daily bars into the same [time,open,high,low,close,volume]
  // array shape the crypto checks already expect — array index stands in
  // for time since only recency/ordering matters to these functions, not
  // the actual timestamp value.
  const k = Array.isArray(bars) ? bars.map((b, i) => [i, b.o, b.h, b.l, b.c, b.v]) : [];

  const freshness = calcEntryFreshness(k, r15, {
    chaseWarnStreak:  STOCK_CHASE_WARN_STREAK,
    chaseBlockStreak: STOCK_CHASE_BLOCK_STREAK,
    knifeWarnStreak:  STOCK_KNIFE_WARN_STREAK,
    knifeBlockStreak: STOCK_KNIFE_BLOCK_STREAK,
    rsiHot: STOCK_RSI_HOT,
  });
  const extension = calcEntryExtension(r15, r1h, {
    rsi15Hot: STOCK_RSI_HOT, rsi15VHot: STOCK_RSI_VHOT, rsi1hHot: STOCK_RSI_CONFIRM_HOT,
  });
  const quality  = calcSignalQuality(bullConfCount, whaleScore, false); // no off-hours concept for daily bars
  const pullback = calcPullbackFromHigh(k, currentPrice, {
    lookback: STOCK_PULLBACK_LOOKBACK, warnPct: STOCK_PULLBACK_WARN_PCT, blockPct: STOCK_PULLBACK_BLOCK_PCT,
  });

  const penalty = freshness.penalty + freshness.knifePenalty + extension.penalty + quality.penalty + pullback.penalty;
  const reasons = [freshness.reason, freshness.knifeReason, extension.reason, quality.reason, pullback.reason].filter(Boolean);

  return { penalty, reasons, freshness, extension, quality, pullback, tod: { penalty: 0, reason: null, isOffHours: false } };
}