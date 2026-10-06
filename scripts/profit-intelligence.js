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
const PROFIT_MIN_PCT    = parseFloat(process.env.SELL_PROFIT_MIN_PCT    || '0.8');
const RSI_ROLLOVER_DROP = parseFloat(process.env.SELL_PROFIT_RSI_ROLLOVER_DROP || '5'); // 15m RSI points dropped from an extended reading to count as "rolling over"
const RSI_EXTENDED      = parseFloat(process.env.SELL_PROFIT_RSI_EXTENDED      || '70');
const MIN_WEAK_SIGNALS  = parseInt(process.env.SELL_PROFIT_MIN_WEAK_SIGNALS || '2', 10);
const RUNNER_MIN_PCT     = parseFloat(process.env.SELL_PROFIT_RUNNER_MIN_PCT || '0.6');
// Breakeven lock (added after the 2026-09-18..10-02 review: 16 Profit
// Protection exits averaged -0.30%, 9 of them closed NEGATIVE, i.e. the
// "protection" never protected). Once the peak has reached LOCK_PEAK, an
// exit fires as soon as pnl falls to LOCK_FLOOR or below, WITHOUT waiting
// for the momentum-weakness confirmation (which tends to arrive only after
// the price has already fallen through breakeven). LOCK_FLOOR should clear
// the round-trip fee + slippage.
// Trailing stop (added after the 2026-10-05 review). The give-back rule below needs
// BOTH a drawdown and confirmed weak momentum, and in RISK_ON / broad-breadth tape
// it also doubles the tolerated drawdown (SELL_PROFIT_REGIME_GIVEBACK_MULT=2.0), so
// winners gave back close to or over 1% before exiting: XRP peak +1.41% -> +0.49%,
// DOGE +1.08% -> +0.12%, SUI +0.96% -> -0.44%. This trail has no momentum condition
// and no regime widening: once the peak has cleared the profit floor, exit when price
// falls max(TRAIL_MIN_PCT, TRAIL_FRAC x peak) below the peak. The fraction gives big
// runners more room (peak +3% tolerates about 1.05%). It cannot beat the check cadence:
// a dip that starts and finishes between two runs is only seen at the next run.
const TRAIL_ENABLED  = (process.env.SELL_PROFIT_TRAIL_ENABLE ?? 'true') !== 'false';
const TRAIL_MIN_PCT  = parseFloat(process.env.SELL_PROFIT_TRAIL_MIN_PCT || '0.5');
const TRAIL_FRAC     = parseFloat(process.env.SELL_PROFIT_TRAIL_FRAC    || '0.35');
const LOCK_PEAK  = parseFloat(process.env.SELL_PROFIT_LOCK_PEAK  || '1.0');
const LOCK_FLOOR = parseFloat(process.env.SELL_PROFIT_LOCK_FLOOR || '0.2');

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
  { label: 'B',  minPeak: parseFloat(process.env.SELL_PROFIT_TIER_B_PEAK     || '0.8'), giveBack: parseFloat(process.env.SELL_PROFIT_TIER_B_GIVEBACK     || '0.3') },
  { label: 'C',  minPeak: parseFloat(process.env.SELL_PROFIT_TIER_C_PEAK     || PROFIT_MIN_PCT.toString()), giveBack: parseFloat(process.env.SELL_PROFIT_TIER_C_GIVEBACK || '0.3') },
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

// pickTier returns the FIRST match, so tiers must be ordered highest peak
// first. Sorting here keeps that true even if env overrides reorder them
// (e.g. raising the C floor above B's would otherwise leave C unreachable).
TIERS.sort((a, b) => b.minPeak - a.minPeak);

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

  // ── Step 2b: breakeven lock — a trade that has proven itself (peak >=
  // LOCK_PEAK) must not be allowed to fall back to a loss. Exits without
  // requiring momentum confirmation. ──
  if (highestPnLSeen >= LOCK_PEAK && pnlPct <= LOCK_FLOOR) {
    pos.prevPnLPct = pnlPct;
    return {
      action: 'EXIT',
      reason: `Profit Protection Triggered: breakeven lock — peak +${highestPnLSeen.toFixed(2)}% fell back to +${pnlPct.toFixed(2)}% (≤ ${LOCK_FLOOR}% floor)`,
      highestPnLSeen, drawdownFromPeak: highestPnLSeen - pnlPct, tier: 'LOCK', giveBack: highestPnLSeen - LOCK_FLOOR,
      regimeMult: 1, momentum: null, strongContinuation: false,
    };
  }

  // ── Step 2c: trailing stop — unconditional once the peak has cleared the floor. ──
  if (TRAIL_ENABLED) {
    const trailDist = Math.max(TRAIL_MIN_PCT, TRAIL_FRAC * highestPnLSeen);
    const dd = highestPnLSeen - pnlPct;
    if (dd + 1e-9 >= trailDist) {   // epsilon: 0.96 - 0.46 must count as 0.50, not 0.4999999
      pos.prevPnLPct = pnlPct;
      return {
        action: 'EXIT',
        reason: `Profit Protection Triggered: trailing stop — peak +${highestPnLSeen.toFixed(2)}% fell ${dd.toFixed(2)}% to +${pnlPct.toFixed(2)}% (≥ ${trailDist.toFixed(2)}% trail)`,
        highestPnLSeen, drawdownFromPeak: dd, tier: 'TRAIL', giveBack: trailDist,
        regimeMult: 1, momentum: null, strongContinuation: false,
      };
    }
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
