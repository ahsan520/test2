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
// Two checks, both aimed at the same trade-log pattern: repeat entries that
// get caught by Position Intelligence's thesis-invalidated check within
// 30-90 minutes — i.e. the thesis wasn't really broken by news or a real
// reversal, the entry itself was already exhausted or already turning.
//
//   1. RSI extension — calcConviction()'s own penalty for this
//      (`r15 > 70 && r4h > 65`) requires BOTH timeframes simultaneously
//      extended, worth only -1. A symbol can be hot on the entry timeframe
//      (r15=72) with a cool r4h and take zero penalty. calcEntryExtension
//      below scores each timeframe independently.
//   2. Candle-run chasing — 2-3+ consecutive green 15m candles before entry
//      means the move is already well underway; buying into that is
//      chasing, not catching a fresh spike. calcEntryFreshness below counts
//      the current same-direction candle streak from the 15m klines
//      leaderboard-scanner.js already fetches (no new API calls needed).
//
// Both return a small penalty (not a hard block) — folded into conv score
// in leaderboard-scanner.js — plus the raw diagnostics, so the reasoning is
// visible in market-data.json the same way bullChecks/entrySnapshot are.
// ══════════════════════════════════════════════════════════════════════════════

const CHASE_ENABLED = (process.env.BUY_ENABLE_CHASE_CHECK || 'true') !== 'false';
// Crypto moves fast — the whole spike can play out in minutes, not the
// 75-105 min a 5-7 candle streak would take to build. Decide runs every
// 5 min specifically because crypto can turn that quickly, so a chase
// check calibrated for a slower asset class (stocks) would mostly fire
// AFTER the move already peaked and reversed — too late to matter.
// Tightened to 2-3 closed 15m candles (30-45 min), matching the pace
// this system already reacts on.
const CHASE_WARN_STREAK  = parseInt(process.env.BUY_CHASE_WARN_STREAK  || '2', 10); // consecutive green 15m candles -> -1
const CHASE_BLOCK_STREAK = parseInt(process.env.BUY_CHASE_BLOCK_STREAK || '3', 10); // -> -2

const RSI_ENABLED = (process.env.BUY_ENABLE_RSI_EXTENSION_CHECK || 'true') !== 'false';
const RSI_15M_HOT  = parseFloat(process.env.BUY_RSI_15M_HOT  || '70'); // matches bullConf's existing rsiNotOb line
const RSI_15M_VHOT = parseFloat(process.env.BUY_RSI_15M_VHOT || '78');
const RSI_1H_HOT   = parseFloat(process.env.BUY_RSI_1H_HOT   || '68');

// ── Candle-run "chasing" check ──────────────────────────────────────────
// Counts the current unbroken streak of same-direction 15m candles ending
// at the most recent one. A long green streak means price has already run
// — the earlier, higher-conviction part of the move already happened.
//
// IMPORTANT: fetch runs every 5 min but a 15m candle takes 15 min to
// close, so Binance's klines response always has the CURRENT, still-
// forming candle as the last element — 2 of every 3 fetch cycles see an
// incomplete candle. Counting it would make the streak (and its penalty)
// flicker within a single 15m window as that candle's own color changes
// while it's still building — noise, not a real signal. So this drops
// the last candle and starts the streak from the last CLOSED one.
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
// Independent per-timeframe scoring (not calcConviction's AND-gated
// r15>70 && r4h>65), so a symbol hot on ONE timeframe still takes a
// penalty instead of needing both simultaneously to trip anything.
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

// ── Combined entry check — called once per symbol from scoreSymbol() ──
export function evaluateBuyReadiness({ r15, r1h, k15 }) {
  const freshness = calcEntryFreshness(k15);
  const extension = calcEntryExtension(r15, r1h);
  const penalty = freshness.penalty + extension.penalty;
  const reasons = [freshness.reason, extension.reason].filter(Boolean);
  return { penalty, reasons, freshness, extension };
}
