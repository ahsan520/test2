// ══════════════════════════════════════════════════════════════════════════════
// st-timing-engine.js — ST5/ST15 TIMING ENGINE (P2 entry-timing layer)
//
// Implements the "ST5/ST15 Timing Engine" dev-team doc (22 Aug 2026) —
// supersedes the simpler st-alignment-check.js gate from the earlier
// "P0/P1/P2 WATCH + ST Alignment" doc. Same architectural boundary as
// before: this is an entry-TIMING confirmation layer for the P2 (frequent)
// engine, entirely separate from:
//
//   - P0/P1 (mexc-trader.js executeST5PriorityRotation /
//     executeSTPriorityRotation) — fresh closed-candle RED→GREEN Supertrend
//     CROSS EVENTS. Rare, event-driven, unaffected by any of this.
//   - Conviction scoring (evald.conv / calcConviction) — this module NEVER
//     feeds into that score. It produces a separate ST_TIMING_SCORE (0-95,
//     per the doc's own stated component weights, which sum to 95 not 100 —
//     reported as-is rather than padded to a round number) used only for
//     display/tie-breaking, plus a pass/fail P2 state.
//
// ── P2 STATE (§9 flow, §14 pseudocode) ──
//   BLOCK        — falling knife, or ST5 EXHAUSTED zone (>2.0 ATR). Hard.
//                  No score, no trigger, no CONV can override this.
//   WAIT_RETEST  — extended/very-extended zone (0.75-2.0 ATR) without a
//                  qualifying retest yet. Not a rejection — re-evaluated
//                  fresh every cycle as price/ST move.
//   WAIT         — ST alignment unfavorable (BEAR/BULL transition, or
//                  BULL/BEAR mixed without the stricter-trigger exception).
//   READY        — passed every ST-timing check. Caller still must confirm
//                  a real trigger (BREAKOUT/TRIGGERING) and run every other
//                  existing P2 gate (Entry Quality Check, cooldown, open-
//                  position, etc.) before this becomes an actual buy —
//                  READY means "ST timing is not the reason to say no."
//
// ── ALIGNMENT (§3) ──
//   ST5 BULL, ST15 BULL           → STRONG        — preferred, normal P2.
//   ST5 BULL, ST15 BEAR           → mixed          — "reject unless explicit
//                                                     exception exists" (§3).
//                                                     Exception used here:
//                                                     a fully confirmed
//                                                     BREAKOUT trigger AND
//                                                     (GOOD_ENTRY zone OR a
//                                                     qualifying retest) —
//                                                     reuses the existing
//                                                     triggerStatus primitive
//                                                     rather than inventing
//                                                     a new one, same as the
//                                                     prior alignment gate.
//   ST5 BEAR, ST15 BULL           → "avoid while fast trend is falling" (§3)
//                                    — always WAIT, no exception defined.
//   ST5 BEAR, ST15 BEAR           → falling knife / no P2 (§3, §5) — BLOCK.
//   Either ST missing              → WAIT — never treated as confirmation.
//
// All numeric thresholds below are env-var configurable with the doc's own
// suggested starting values as defaults — the doc explicitly says these
// "should be configurable and validated with historical/backtest data
// before being fixed" (§4, §16), so nothing here is hardcoded.
// ══════════════════════════════════════════════════════════════════════════════

function num(name, def) { return parseFloat(process.env[name] ?? def); }

const SLOPE_STRONG_MIN = num('ST_SLOPE_STRONG_MIN', '0.15'); // ATR/bar — same default as leaderboard-scanner.js's enrichment

export function checkFallingKnife(entry, st5, st15) {
  const reasons = [];

  // "ST5 BEAR or price below ST5" — direction BEAR *is* "price below ST5"
  // for this indicator (see leaderboard-scanner.js calcSupertrend: dir
  // BEAR only occurs once close < the resistance band it's tracking).
  if (st5.direction === 'BEAR' && st15.direction === 'BEAR') {
    reasons.push('ST5 and ST15 both BEAR — price below both ST levels');
  } else {
    // "ST15 BEAR with deteriorating fast trend" — ST15 bearish while ST5's
    // own slope is turning down too, even if ST5 hasn't fully flipped BEAR
    // yet — an early warning the doc explicitly calls out separately from
    // the simpler BEAR/BEAR case above. Uses the same SLOPE_STRONG_MIN
    // threshold as the check below it, not a bare <0 — a fresh ST5 bull
    // cross very often still has a barely-negative trailing slope for a
    // few bars while ST15 catches up (lookback window still includes
    // pre-cross candles), which isn't a knife, just lag. Requiring a real
    // magnitude here avoids blocking that normal case.
    if (st15.direction === 'BEAR' && st5.slope != null && st5.slope <= -SLOPE_STRONG_MIN) {
      reasons.push('ST15 BEAR with ST5 slope turning negative — deteriorating fast trend');
    }
  }

  // "Strongly negative ST5 slope" — on its own, regardless of direction.
  if (st5.slope != null && st5.slope <= -SLOPE_STRONG_MIN) {
    reasons.push(`ST5 slope strongly negative (${st5.slope}/bar)`);
  }

  // "Confirming negative momentum/flow/shock conditions" — rather than
  // re-deriving shock/momentum/flow logic here (duplicating signal-
  // evaluator.js), reuse its own FALLING KNIFE classification, which
  // already synthesizes exactly those inputs.
  if (entry.signal === 'FALLING KNIFE') {
    reasons.push('signal-evaluator already classified this as FALLING KNIFE (momentum/flow/shock)');
  }

  return { isFallingKnife: reasons.length > 0, reasons };
}

export function checkExhaustedEntry(st5, st15) {
  // Hard block — beyond backtestable "wait for retest", this is simply too
  // extended to be a reasonable entry regardless of what happens next.
  if (st5.extensionZone === 'EXHAUSTED') {
    return { blocked: true, waitRetest: false, reason: `ST5 distance ${st5.distanceATR} ATR — EXHAUSTED zone, hard block` };
  }
  if (st15.extensionZone === 'EXHAUSTED') {
    return { blocked: true, waitRetest: false, reason: `ST15 distance ${st15.distanceATR} ATR — EXHAUSTED zone, hard block` };
  }

  // Softer zones — a qualifying retest is the escape hatch; without one,
  // wait rather than chase.
  if ((st5.extensionZone === 'EXTENDED' || st5.extensionZone === 'VERY_EXTENDED') && !st5.retest) {
    return {
      blocked: false, waitRetest: true,
      reason: `ST5 distance ${st5.distanceATR} ATR (${st5.extensionZone}) with no confirmed retest yet`,
    };
  }

  return { blocked: false, waitRetest: false, reason: null };
}

export function checkSTAlignment(entry, st5, st15) {
  if (st5.direction == null || st15.direction == null) {
    return { ok: false, alignment: null, reason: `ST${st5.direction == null ? '5' : '15'} not available yet — missing ST is never treated as bullish confirmation` };
  }
  if (st5.direction === 'BULL' && st15.direction === 'BULL') {
    return { ok: true, alignment: 'STRONG', reason: 'ST5 and ST15 both BULL — strong alignment' };
  }
  if (st5.direction === 'BEAR' && st15.direction === 'BULL') {
    return { ok: false, alignment: 'TRANSITION', reason: 'ST5 BEAR, ST15 BULL — avoid while fast trend is falling' };
  }
  // ST5 BULL, ST15 BEAR — mixed; allowed only via the explicit exception.
  const strongTrigger  = entry.triggerStatus === 'BREAKOUT';
  const controlledEntry = st5.extensionZone === 'GOOD_ENTRY' || st5.retest;
  const exceptionMet = strongTrigger && controlledEntry;
  return {
    ok: exceptionMet, alignment: 'MIXED',
    reason: exceptionMet
      ? 'ST5 BULL, ST15 BEAR — allowed via confirmed BREAKOUT + controlled entry (retest or GOOD_ENTRY zone)'
      : `ST5 BULL, ST15 BEAR — needs confirmed BREAKOUT + controlled entry (trigger=${entry.triggerStatus ?? 'n/a'}, zone=${st5.extensionZone ?? 'n/a'}, retest=${st5.retest})`,
  };
}

// §8 — separate timing score, 0-95 (doc's own weights sum to 95). Never
// feeds conviction. Purely for display / optional tie-breaking when
// multiple candidates pass every gate the same cycle.
export function calcTimingScore({ st5, st15, alignment, fallingKnife, exhausted }) {
  let score = 0;
  score += st5.direction  === 'BULL' ? 20 : 0;                                    // ST5 direction
  score += st15.direction === 'BULL' ? 20 : 0;                                    // ST15 direction
  score += alignment === 'STRONG' ? 15 : alignment === 'MIXED' ? 8 : 0;           // alignment
  score += st5.slope == null || st5.slope < 0 ? 0
         : st5.slopeStrength === 'STRONG' ? 10 : st5.slopeStrength === 'NORMAL' ? 6 : 3; // slope
  score += st5.extensionZone === 'GOOD_ENTRY' ? 15
         : st5.extensionZone === 'EXTENDED'   ? 8
         : st5.extensionZone === 'VERY_EXTENDED' ? 3 : 0;                          // distance/ATR
  score += st5.retest ? 10 : 0;                                                    // retest quality
  score += st5.barsSinceCross <= 3 ? 5 : st5.barsSinceCross <= 8 ? 3 : 1;          // cross freshness
  if (exhausted.blocked || exhausted.waitRetest) score -= 20;                      // exhaustion penalty
  if (fallingKnife.isFallingKnife) score -= 30;                                    // falling-knife penalty
  return Math.max(0, Math.round(score));
}

// Main entry point — mirrors §14's pseudocode shape.
export function evaluateSTTiming(entry) {
  const st5  = entry.supertrend5m;
  const st15 = entry.supertrend15m;

  if (!st5 || !st15) {
    return { p2State: 'WAIT', timingScore: 0, reason: `ST${!st5 ? '5' : '15'} not available yet (insufficient closed-candle history)` };
  }

  const fallingKnife = checkFallingKnife(entry, st5, st15);
  if (fallingKnife.isFallingKnife) {
    return { p2State: 'BLOCK', timingScore: 0, reason: fallingKnife.reasons.join(' · '), fallingKnife };
  }

  const exhausted = checkExhaustedEntry(st5, st15);
  if (exhausted.blocked) {
    return { p2State: 'BLOCK', timingScore: 0, reason: exhausted.reason, exhausted };
  }

  const alignment = checkSTAlignment(entry, st5, st15);
  const timingScore = calcTimingScore({ st5, st15, alignment: alignment.alignment, fallingKnife, exhausted });

  if (exhausted.waitRetest) {
    return { p2State: 'WAIT_RETEST', timingScore, reason: exhausted.reason, alignment, exhausted };
  }
  if (!alignment.ok) {
    return { p2State: 'WAIT', timingScore, reason: alignment.reason, alignment };
  }

  return { p2State: 'READY', timingScore, reason: alignment.reason, alignment, st5Dir: st5.direction, st15Dir: st15.direction };
}
