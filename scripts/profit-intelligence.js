// ══════════════════════════════════════════════════════════════════════════════
// profit-intelligence.js — Profit Intelligence Engine
// (Design Proposal: "Profit Intelligence Engine", Aug 2026)
//
// Position Intelligence (position-intelligence.js) protects against LOSING
// trades by validating the original buy thesis. It does NOT protect
// unrealized profit — a trade can go +22% then round-trip all the way back
// to breakeven/loss while Position Intelligence still says HOLD, because the
// *thesis* never actually broke.
//
// This engine is a fully independent sell reason that runs alongside
// Position Intelligence and the existing CVD/OI/FR/RSI exit score. It never
// touches those — it only adds a new possible close reason:
//
//   "Profit Protection Triggered"
//
// Design (from the proposal doc):
//   1. Track highest unrealized PnL seen since entry (highestPnLSeen).
//   2. Ignore the position entirely until it has reached a minimum profit
//      (SELL_PROFIT_MIN_PCT, default 0.4%) — never fires on a trade that was never
//      meaningfully in profit.
//   3. Once above that floor, watch drawdown-from-peak
//      (highestPnLSeen - currentPnL).
//   4. Also require momentum deterioration (CVD/OI/breadth fading, or RSI
//      rolling over from an extended reading) — a peak alone isn't enough,
//      the move actually has to be turning.
//   5. Only sell when BOTH the drawdown and the momentum weakness are
//      confirmed together.
//   6. Adaptive give-back thresholds: the higher the peak reached, the more
//      give-back is tolerated before exiting (a trade that ran to +22% is
//      allowed to give back more than one that barely cleared +8%) —
//      rewards runners instead of clipping them at the same fixed distance
//      a small winner would be clipped at.
//
// Buy → +18% → +22% (peak) → +17% → +13% → +9%: existing sell reasons may
// all still say HOLD (thesis intact, no falling-knife, no CVD exit score) —
// Profit Intelligence is what actually exits this trade, once drawdown from
// the +22% peak and weakening momentum are both confirmed.
// ══════════════════════════════════════════════════════════════════════════════

const ENABLED           = (process.env.SELL_ENABLE_PROFIT_INTELLIGENCE || 'true') !== 'false';
// Floor rescaled to this system's actual T1/T2 geometry — t1 = entry +
// 2*atr, t2 = entry + 4*atr, where atr = price*0.015*shock, which lands
// T1 ≈ +3% and T2 ≈ +6% at baseline shock. 4% sits just past T1, so a
// trade has to clear a real move (not noise) before Profit Intelligence
// starts watching it — the PDF's own default of 8% would leave most
// T1/T2-sized winners completely unprotected.
const PROFIT_MIN_PCT    = parseFloat(process.env.SELL_PROFIT_MIN_PCT    || '0.4');
const RSI_ROLLOVER_DROP = parseFloat(process.env.SELL_PROFIT_RSI_ROLLOVER_DROP || '5'); // 15m RSI points dropped from an extended reading to count as "rolling over"
const RSI_EXTENDED      = parseFloat(process.env.SELL_PROFIT_RSI_EXTENDED      || '70');
const MIN_WEAK_SIGNALS  = parseInt(process.env.SELL_PROFIT_MIN_WEAK_SIGNALS || '2', 10);
const RUNNER_MIN_PCT     = parseFloat(process.env.SELL_PROFIT_RUNNER_MIN_PCT || '0.6');

// ── Adaptive give-back thresholds, keyed by how high the peak ran ──
// { minPeak: highestPnLSeen must be >= this to use this tier, giveBack: how
// much drawdown-from-peak is tolerated before this tier is willing to exit }
// Order matters — first (highest) match wins, so check A+ before A before
// B before C. Rescaled tight to this system's actual observed intraday
// range on crypto majors (e.g. LINK's whole day ran ~2%, individual legs
// 0.3-0.9%) rather than the PDF's generic 8/15/20 numbers — deliberately
// "not greedy": lock in small wins early and let the leaderboard re-buy on
// the next signal rather than risk giving a winner back. Overridable
// individually via env without touching the others.
const TIERS = [
  { label: 'A+', minPeak: parseFloat(process.env.SELL_PROFIT_TIER_APLUS_PEAK || '1.5'), giveBack: parseFloat(process.env.SELL_PROFIT_TIER_APLUS_GIVEBACK || '0.75') },
  { label: 'A',  minPeak: parseFloat(process.env.SELL_PROFIT_TIER_A_PEAK     || '1.0'), giveBack: parseFloat(process.env.SELL_PROFIT_TIER_A_GIVEBACK     || '0.5') },
  { label: 'B',  minPeak: parseFloat(process.env.SELL_PROFIT_TIER_B_PEAK     || '0.6'), giveBack: parseFloat(process.env.SELL_PROFIT_TIER_B_GIVEBACK     || '0.3') },
  { label: 'C',  minPeak: parseFloat(process.env.SELL_PROFIT_TIER_C_PEAK     || PROFIT_MIN_PCT.toString()), giveBack: parseFloat(process.env.SELL_PROFIT_TIER_C_GIVEBACK || '0.2') },
];

// ── Regime-aware widening (2026-09-03) ──────────────────────────────────
// The tiers above are calibrated for a normal ~2% intraday range. On a
// genuinely broad, trending day (BTC 4h bias bull, RISK_ON regime, breadth
// still high) that same tight band clips winners early against a move
// that's still running — observed 2026-09-03: FET/LINK both exited via
// Profit Protection on a day BTC ran +5.59% and both symbols independently
// moved 4-8% after exit. Mirrors the buy-side EXHAUSTED broad-rally
// exception (st-timing-engine.js) — same idea, sell side: don't apply the
// choppy-day band on a day that isn't choppy. Only the give-back distance
// widens; minPeak floors are untouched, so this never makes the engine
// start protecting profit earlier — only lets it tolerate more pullback
// before pulling the trigger once it's already watching.
const REGIME_SCALE_ENABLED     = (process.env.SELL_PROFIT_REGIME_SCALE_ENABLE ?? 'true') !== 'false';
const REGIME_MIN_BREADTH       = parseFloat(process.env.SELL_PROFIT_REGIME_MIN_BREADTH || '70');
const REGIME_GIVEBACK_MULT     = parseFloat(process.env.SELL_PROFIT_REGIME_GIVEBACK_MULT || '2.0');

function regimeGivebackMultiplier(marketState) {
  if (!REGIME_SCALE_ENABLED) return 1;
  const isRiskOn      = marketState?.marketRegime === 'RISK_ON';
  const breadthScore  = marketState?.breadth?.score;
  const broadBreadth  = breadthScore != null && breadthScore >= REGIME_MIN_BREADTH;
  return (isRiskOn && broadBreadth) ? REGIME_GIVEBACK_MULT : 1;
}

export function profitIntelligenceEnabled() { return ENABLED; }

function pickTier(highestPnLSeen) {
  for (const t of TIERS) {
    if (highestPnLSeen >= t.minPeak) return t;
  }
  return null; // below even the lowest tier's floor
}

// ── Momentum deterioration — reuses the same per-symbol momentum feeds
// Position Intelligence's Falling Knife Score already reads (cvdMomentum /
// oiMomentum come from market-state.json's symbolState, breadthMomentum
// from the top-level marketState) so this stays consistent with the rest
// of the sell-side stack instead of inventing a second momentum source. ──
export function isMomentumWeak({ symbolState, marketState, r15, lastR15 }) {
  const cvdFading     = symbolState?.cvdMomentum?.trend === 'FADING';
  const oiFading      = symbolState?.oiMomentum?.trend === 'FADING';
  const breadthFading = marketState?.breadthMomentum?.trend === 'FADING';

  // RSI "rolling over": was extended last cycle (or currently still above
  // the extended line) and has dropped by RSI_ROLLOVER_DROP+ points since
  // the last reading we have on file for this position — a genuine
  // hook-down out of overbought, not just a fixed level check.
  const rsiRollingOver =
    lastR15 != null && r15 != null &&
    lastR15 >= RSI_EXTENDED &&
    (lastR15 - r15) >= RSI_ROLLOVER_DROP;

  const weakSignalCount = [cvdFading, oiFading, breadthFading, rsiRollingOver].filter(Boolean).length;
  return {
    weak: weakSignalCount >= MIN_WEAK_SIGNALS,
    weakSignalCount,
    cvdFading, oiFading, breadthFading, rsiRollingOver,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// evaluateProfitProtection — called once per open crypto position per cycle,
// AFTER Position Intelligence and BEFORE the CVD/OI/FR/RSI exit score, from
// position-monitor.js's monitorPositions() loop.
//
// Mutates pos.highestPnLSeen and pos.lastR15 as a side effect (that's the
// whole point — it's a running peak tracker), same pattern job-state.js
// positions already use for pos.stop / pos.piPartialLevel etc.
//
// pos:          tracked position object (positions.json entry)
// symbolState:  market-state.json's symbols[sym] (cvdMomentum/oiMomentum)
// marketState:  top-level market-state.json (breadthMomentum)
// r15:          current 15m RSI reading (mData.d.r15)
// pnlPct:       current unrealized P&L %, already computed by the caller
// ══════════════════════════════════════════════════════════════════════════════
export function evaluateProfitProtection({ pos, symbolState, marketState, r15, pnlPct }) {
  if (!ENABLED) return { action: 'HOLD', reason: 'profit intelligence disabled', skipped: true };
  if (pnlPct == null || isNaN(pnlPct)) return { action: 'HOLD', reason: 'no pnl available', skipped: true };

  // ── Step 1: track highest unrealized PnL seen since entry ──
  const priorHigh       = pos.highestPnLSeen ?? -Infinity;
  const highestPnLSeen  = Math.max(priorHigh, pnlPct);
  pos.highestPnLSeen    = highestPnLSeen;

  const lastR15 = pos.lastR15 ?? null;
  pos.lastR15   = r15 ?? lastR15;

  // ── Step 2: ignore until the position has reached minimum profit ──
  if (highestPnLSeen < PROFIT_MIN_PCT) {
    return {
      action: 'HOLD', reason: `peak ${highestPnLSeen.toFixed(2)}% below ${PROFIT_MIN_PCT}% floor — not evaluated yet`,
      highestPnLSeen, drawdownFromPeak: 0, skipped: true,
    };
  }

  // ── Step 3: drawdown from peak ──
  const drawdownFromPeak = highestPnLSeen - pnlPct;

  // ── Step 4: momentum deterioration ──
  const momentum = isMomentumWeak({ symbolState, marketState, r15, lastR15 });

  // ── Adaptive tier selection — higher peaks tolerate more give-back ──
  const tier = pickTier(highestPnLSeen);
  if (!tier) {
    return {
      action: 'HOLD', reason: `peak ${highestPnLSeen.toFixed(2)}% did not clear a give-back tier`,
      highestPnLSeen, drawdownFromPeak, momentum,
    };
  }

  // Regime-aware widening — only the tolerated give-back distance scales,
  // the tier the position qualified for (based on its own peak) doesn't
  // change.
  const regimeMult      = regimeGivebackMultiplier(marketState);
  const effectiveGiveBack = tier.giveBack * regimeMult;

  // ── Step 5: sell only if BOTH drawdown and CONFIRMED weakening momentum. ──
  // A single fading feed is not enough to stop a strong runner. This engine
  // requires MIN_WEAK_SIGNALS independent deterioration signals.
  const drawdownConfirmed = drawdownFromPeak >= effectiveGiveBack;
  const strongContinuation =
    pnlPct >= RUNNER_MIN_PCT &&
    pnlPct >= (pos.prevPnLPct ?? pnlPct) &&
    !momentum.weak;
  pos.prevPnLPct = pnlPct;

  if (drawdownConfirmed && momentum.weak && !strongContinuation) {
    const signals = [
      momentum.cvdFading     ? 'CVD fading'        : null,
      momentum.oiFading      ? 'OI fading'          : null,
      momentum.breadthFading ? 'Breadth weakening'  : null,
      momentum.rsiRollingOver ? `RSI rolling over (${lastR15?.toFixed(0)}→${r15?.toFixed(0)})` : null,
    ].filter(Boolean).join(' · ');

    return {
      action: 'EXIT',
      reason: `Profit Protection Triggered: peak +${highestPnLSeen.toFixed(2)}% (tier ${tier.label}) → now +${pnlPct.toFixed(2)}%, gave back ${drawdownFromPeak.toFixed(2)}% ≥ ${effectiveGiveBack.toFixed(2)}%${regimeMult > 1 ? ` (${tier.giveBack}% × ${regimeMult} regime-widened)` : ''} with weakening momentum [${signals}]`,
      highestPnLSeen, drawdownFromPeak, tier: tier.label, giveBack: effectiveGiveBack, regimeMult, momentum, strongContinuation,
    };
  }

  return {
    action: 'HOLD',
    reason: !drawdownConfirmed
      ? `drawdown ${drawdownFromPeak.toFixed(2)}% below tier ${tier.label} give-back ${effectiveGiveBack.toFixed(2)}%${regimeMult > 1 ? ' (regime-widened)' : ''}`
      : strongContinuation
        ? `drawdown ${drawdownFromPeak.toFixed(2)}% ≥ ${effectiveGiveBack.toFixed(2)}% but momentum/price continuation is still strong — holding, letting it run`
        : `drawdown ${drawdownFromPeak.toFixed(2)}% ≥ ${effectiveGiveBack.toFixed(2)}% but confirmed momentum weakness not met (${momentum.weakSignalCount}/${MIN_WEAK_SIGNALS}) — holding, letting it run`,
    highestPnLSeen, drawdownFromPeak, tier: tier.label, giveBack: effectiveGiveBack, regimeMult, momentum, strongContinuation,
  };
}
