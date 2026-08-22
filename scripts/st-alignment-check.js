// ══════════════════════════════════════════════════════════════════════════════
// st-alignment-check.js — ST5/ST15 CURRENT-STATE alignment (P2 timing/
// confirmation layer)
//
// Implements the "P0/P1/P2 WATCH + ST Alignment" dev-team doc (§3, §4, §7,
// §8) — a SEPARATE confirmation/timing gate for the P2 (frequent) buy
// engine, distinct from and complementary to:
//
//   - P0/P1 (mexc-trader.js executeST5PriorityRotation /
//     executeSTPriorityRotation) — fire on a FRESH closed-candle
//     RED→GREEN Supertrend CROSS EVENT. Rare, event-driven, independent
//     priority paths that bypass normal P2 strategy qualification entirely.
//
//   - This module — reads the CURRENT ST5/ST15 direction (BULL/BEAR), no
//     fresh cross required, as a confirmation/timing layer for the P2
//     engine's much more frequent BUY/EARLY BUY/WATCH candidates.
//
// Per the doc: "P2 uses the current ST5/ST15 state as a timing/confirmation
// layer; it does not wait for a fresh Supertrend cross." And explicitly:
// "Do not add ST5/ST15 as arbitrary conviction-score weights" — this is a
// pass/fail gate only, never folded into evald.conv/calcConviction.
//
// ── ALIGNMENT (§3) ──
//   ST5 BULL, ST15 BULL → STRONG        — normal P2 threshold, best case.
//   ST5 BULL, ST15 BEAR → EARLY_MIXED   — allowed, but requires a stricter
//                                          trigger bar (a fully confirmed
//                                          BREAKOUT, not merely TRIGGERING /
//                                          the RETEST exception) per §3/§7
//                                          (P2-B tier: "strong trigger +
//                                          good entry").
//   ST5 BEAR, ST15 BULL → TRANSITION    — per the doc's own §8 decision-
//                                          boundary pseudocode, this never
//                                          returns P2_BUY directly — falls
//                                          through to WATCH. (§3's prose
//                                          says "allow only with strong
//                                          evidence", but the doc gives no
//                                          numeric definition for that, and
//                                          explicitly leaves numeric
//                                          thresholds for later
//                                          configuration/backtesting — so
//                                          this module follows the actual
//                                          pseudocode, which the dev team
//                                          labeled as the implementation
//                                          spec, not the looser prose.)
//   ST5 BEAR, ST15 BEAR → BLOCK          — hard block, remain WATCH (§4).
//   Either ST missing   → BLOCK          — insufficient data must never be
//                                          treated as bullish confirmation
//                                          (§3's alignment table, "Missing"
//                                          row).
//
// Crypto-only: supertrend5m/supertrend15m are only ever computed for
// crypto pairs (leaderboard-scanner.js's scoreSymbol) — scoreStock() has no
// equivalent, so this module is never meaningful for stocks/ETFs. Callers
// should only invoke this for entry.assetType === 'crypto'.
// ══════════════════════════════════════════════════════════════════════════════

export function checkSTAlignment(entry) {
  const st5Dir  = entry.supertrend5m?.direction  ?? null; // 'BULL' | 'BEAR' | null
  const st15Dir = entry.supertrend15m?.direction ?? null;

  if (st5Dir == null || st15Dir == null) {
    return {
      pass: false, alignment: null, st5Dir, st15Dir,
      reason: `ST${st5Dir == null ? '5' : '15'} not available yet (insufficient closed-candle history) — missing ST is never treated as bullish confirmation`,
    };
  }

  if (st5Dir === 'BEAR' && st15Dir === 'BEAR') {
    return {
      pass: false, alignment: 'BEAR_BEAR', st5Dir, st15Dir,
      reason: 'ST5 and ST15 both BEAR — bearish structure, P2 BUY blocked, remain WATCH',
    };
  }

  if (st5Dir === 'BULL' && st15Dir === 'BULL') {
    return {
      pass: true, alignment: 'STRONG', st5Dir, st15Dir,
      reason: 'ST5 and ST15 both BULL — strong alignment, normal P2 threshold',
    };
  }

  if (st5Dir === 'BULL' && st15Dir === 'BEAR') {
    // §7 P2-B tier — "strong trigger + good entry" — reuses the existing
    // triggerStatus primitive (buy-intelligence.js calcSpikeTrigger via
    // market-fetcher.js) rather than inventing a new numeric threshold:
    // a fully confirmed BREAKOUT is the "stronger trigger" the doc calls
    // for. TRIGGERING (even via the RETEST exception elsewhere in the P2
    // pipeline) is deliberately NOT enough here — that exception exists
    // for an otherwise-clean STRONG-alignment setup, not to also relax
    // the bar on a mixed ST reading.
    const strongTrigger = entry.triggerStatus === 'BREAKOUT';
    return {
      pass: strongTrigger, alignment: 'EARLY_MIXED', st5Dir, st15Dir,
      reason: strongTrigger
        ? 'ST5 BULL, ST15 still BEAR — early/mixed, allowed via a fully confirmed BREAKOUT (stricter early threshold met)'
        : `ST5 BULL, ST15 still BEAR — early/mixed, needs a fully confirmed BREAKOUT (trigger=${entry.triggerStatus ?? 'n/a'}) — not there yet, remain WATCH`,
    };
  }

  // st5Dir === 'BEAR' && st15Dir === 'BULL'
  return {
    pass: false, alignment: 'TRANSITION', st5Dir, st15Dir,
    reason: 'ST5 BEAR, ST15 BULL — transition; no fresh ST5 confirmation yet, remain WATCH',
  };
}
