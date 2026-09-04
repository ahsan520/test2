// ══════════════════════════════════════════════════════════════════════════════
// position-intelligence.js — Position Intelligence Engine (v15 design doc, Sell-side)
//
// Runs every fetch cycle for every OPEN position. At buy time an entry
// snapshot is captured (buildEntrySnapshot); every cycle after that, the
// CURRENT market-state.json (Market Intelligence Engine output) and
// market-data.json entry for that symbol are compared against the
// snapshot to derive:
//
//   Falling Knife Score   — how much this looks like a still-accelerating
//                           drop rather than normal pullback noise.
//   Thesis Validation     — how much of the ORIGINAL buy thesis (score,
//                           whale, confluence) still holds right now.
//   Confidence Decay      — % erosion of the bullish-confluence checks
//                           (bullChecks) that were true at entry.
//   Recovery Detector     — is price/momentum turning back up after a
//                           dip, which should soften/delay an exit.
//   Exit Probability      — single 0-100 composite of the above, mapped
//                           to an action via the SELL_* thresholds.
//   Position Age          — minutes since entry (gates all of the above —
//                           SELL_MIN_POSITION_AGE_MIN).
//   Dynamic Position Risk — Exit Probability adjusted down when Recovery
//                           Detector fires, so a genuine bounce isn't
//                           punished the same as a knife still falling.
//
// Actions: HOLD / REDUCE_25 / REDUCE_50 / EXIT / EMERGENCY_EXIT
// ══════════════════════════════════════════════════════════════════════════════

const ENABLED                = (process.env.SELL_ENABLE_INTELLIGENCE || 'true') !== 'false';
const FALLING_KNIFE_MAX       = parseFloat(process.env.SELL_FALLING_KNIFE_MAX       || '70');
const THESIS_INVALIDATE_SCORE = parseFloat(process.env.SELL_THESIS_INVALIDATE_SCORE || '60');
const CONFIDENCE_DECAY_MAX    = parseFloat(process.env.SELL_CONFIDENCE_DECAY_MAX    || '35');
const MIN_POSITION_AGE_MIN    = parseFloat(process.env.SELL_MIN_POSITION_AGE_MIN    || '15');
const RECOVERY_WAIT_MIN       = parseFloat(process.env.SELL_RECOVERY_WAIT_MIN       || '10');
const PARTIAL_EXIT_LEVEL1     = parseFloat(process.env.SELL_PARTIAL_EXIT_LEVEL1     || '50');
const PARTIAL_EXIT_LEVEL2     = parseFloat(process.env.SELL_PARTIAL_EXIT_LEVEL2     || '70');
const EMERGENCY_EXIT_LEVEL    = parseFloat(process.env.SELL_EMERGENCY_EXIT_LEVEL    || '85');
const USE_MARKET_REGIME       = (process.env.SELL_USE_MARKET_REGIME    || 'true') !== 'false';
const REQUIRE_BTC_RECOVERY    = (process.env.SELL_REQUIRE_BTC_RECOVERY || 'true') !== 'false';
const RUNNER_SHIELD_ENABLED   = (process.env.SELL_RUNNER_SHIELD_ENABLE || 'true') !== 'false';
const RUNNER_SHIELD_MIN_PCT   = parseFloat(process.env.SELL_RUNNER_SHIELD_MIN_PCT || '0.6');
const RUNNER_MOMENTUM_MIN     = parseInt(process.env.SELL_RUNNER_MOMENTUM_MIN || '2', 10);

// ── Breakout-failure boost — dev-team note "Sell Intelligence / Leaderboard
// Decider" (UPDATED), written up after the UNI incident (bought on a
// BREAKOUT reclaim, chopped back under that exact level, hit the fixed
// stop 20 min later with no intelligence exit in between). The generic
// thesis/confidence composite above never explicitly checks "did price
// re-fall below the specific level this position was entered on" — it can
// stay numerically mild (a soft conv/whale dip) even while the actual
// breakout has already fully round-tripped. This is additive, not a
// standalone trigger — see the PDF's explicit rule: "Breakout weakening
// only ⇒ WARNING, not an immediate sell." It only pushes exitProbability,
// so REDUCE/EXIT still needs the other signals to be non-trivial too.
const BREAKOUT_FAIL_BOOST     = parseFloat(process.env.SELL_BREAKOUT_FAIL_BOOST || '18');

// ── Staleness nudge ──────────────────────────────────────────────────
// Everything above requires real thesis deterioration or falling-knife
// momentum to move exitProbability. A position that's neither winning
// (Profit Intelligence never engages — needs peak profit to fire) nor
// actively deteriorating (nothing above fires either) can sit forever,
// tying up a live slot doing nothing. This adds a modest exitProbability
// bump once a position is old enough AND still genuinely flat, so a truly
// stagnant position eventually gets nudged toward an exit instead of
// being invisible to every existing check. Small and additive — a
// position with any real momentum (up or down) is essentially unaffected
// since |pnlPct| won't be inside the flat band; this only meaningfully
// moves the needle for genuine stagnation.
const STALE_NUDGE_ENABLED  = (process.env.SELL_ENABLE_STALE_NUDGE || 'true') !== 'false';
const STALE_NUDGE_AGE_MIN  = parseFloat(process.env.SELL_STALE_NUDGE_AGE_MIN  || '120'); // 2h
const STALE_NUDGE_FLAT_PCT = parseFloat(process.env.SELL_STALE_NUDGE_FLAT_PCT || '0.3');
const STALE_NUDGE_AMOUNT   = parseFloat(process.env.SELL_STALE_NUDGE_AMOUNT   || '15');

// ── No-snapshot fallback (manually adopted positions) ───────────────
// Positions adopted from an existing MEXC balance (source: manual_adopted)
// never went through buildEntrySnapshot(), so thesisDrop and
// confidenceDecay can't be computed — there's nothing to compare "now"
// against. Previously this meant such positions were 100% invisible to
// Position Intelligence forever, relying solely on the hard price stop.
// fallingKnifeScore, however, only needs CURRENT market state (BTC risk,
// CVD/OI/breadth/whale momentum, pnlPct) — no entry comparison — so it can
// still run. This fallback lets a severe, still-accelerating knife trigger
// an exit even with no snapshot, using a slightly stricter bar than the
// normal ladder (knife score alone, with no thesis/confidence corroboration,
// is a weaker signal than the full composite).
const NO_SNAPSHOT_FALLBACK_ENABLED = (process.env.SELL_NO_SNAPSHOT_FALLBACK || 'true') !== 'false';
const NO_SNAPSHOT_REDUCE25_LEVEL   = parseFloat(process.env.SELL_NO_SNAPSHOT_REDUCE25_LEVEL || '75');
const NO_SNAPSHOT_REDUCE50_LEVEL   = parseFloat(process.env.SELL_NO_SNAPSHOT_REDUCE50_LEVEL || '85');
const NO_SNAPSHOT_EXIT_LEVEL       = parseFloat(process.env.SELL_NO_SNAPSHOT_EXIT_LEVEL     || '92');

export function positionIntelligenceEnabled() { return ENABLED; }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── A single composite "thesis score" — same formula used both at entry
// (snapshot) and live, so the two are directly comparable. Weighted
// toward conviction score and whale accumulation, the two strongest buy
// signals already used elsewhere in this codebase (leaderboard-scanner's
// grade/successProb, market-guard's Alpha Exception). ──
function calcThesisScore({ conv = 0, whaleScore = 0, bullConfCount = 0, bias4h = '' }) {
  let score = 0;
  score += clamp(conv, -10, 10) * 4;               // -40..+40
  score += clamp(whaleScore, 0, 100) * 0.3;         // 0..30
  score += clamp(bullConfCount, 0, 8) * 3;           // 0..24
  if (bias4h.includes('BULL')) score += 6;
  else if (bias4h.includes('BEAR')) score -= 6;
  return Math.round(clamp(score, 0, 100));
}

// ── Captured once, at buy time. Caller (mexc-trader.js / leaderboard-
// decider.js) stores this on the position as `pos.entrySnapshot`. ──
export function buildEntrySnapshot(entry, marketState = {}) {
  const d = entry.d || {};
  const thesisScore = calcThesisScore({
    conv: entry.conv, whaleScore: entry.whale?.score, bullConfCount: entry.bullConf, bias4h: d.bias4h,
  });
  return {
    at:              Date.now(),
    price:           entry.price,
    conv:            entry.conv ?? 0,
    whaleScore:      entry.whale?.score ?? 0,
    bullConfCount:   entry.bullConf ?? 0,
    bullChecks:      entry.bullChecks || {},
    bias4h:          d.bias4h || null,
    cvdTrend:        d.cvdTrend || null,
    thesisScore,
    btcRiskScore:    marketState.btcRiskScore ?? null,
    breadthScore:    marketState.breadth?.score ?? null,
    marketRegime:    marketState.marketRegime || null,
    // Captured for the breakout-failure check below — the exact level and
    // trigger status this position was entered on, so a live re-fall below
    // it can be detected precisely rather than inferred from score alone.
    triggerStatus:   d.trigger?.triggerStatus ?? null,
    breakoutLevel:   d.trigger?.breakoutLevel ?? null,
  };
}

// ── Falling Knife Score — 0 (fine) to 100 (still accelerating down) ──
// f(btcRisk, cvdMomentum, oiMomentum, breadthMomentum, whaleMomentum, pnl)
function calcFallingKnifeScore({ btcRiskScore, cvdMomentum, oiMomentum, breadthMomentum, whaleMomentum, pnlPct }) {
  let score = 0;

  // BTC-wide risk contributes up to 30 pts
  if (btcRiskScore != null) score += clamp(btcRiskScore, 0, 100) * 0.3;

  // CVD still fading = sellers still in control
  if (cvdMomentum?.trend === 'FADING')        score += 20;
  else if (cvdMomentum?.trend === 'ACCELERATING') score -= 10;

  // OI (funding-rate proxy) momentum fading toward more negative funding
  // while price falls = shorts piling in, knife still falling
  if (oiMomentum?.trend === 'FADING')         score += 12;

  // Market-wide breadth deteriorating = broad risk-off, not idiosyncratic
  if (breadthMomentum?.trend === 'FADING')    score += 15;

  // Whale accumulation drying up / reversing = smart money stepping away
  if (whaleMomentum?.trend === 'FADING')      score += 13;
  else if (whaleMomentum?.trend === 'ACCELERATING') score -= 8;

  // The position's own unrealized loss adds directly — a knife falling
  // under YOUR position matters more than one falling elsewhere
  if (pnlPct != null && pnlPct < 0) score += clamp(-pnlPct, 0, 20) * 1.5;

  return Math.round(clamp(score, 0, 100));
}

// ── Confidence Decay — % erosion of bullish-confluence checks vs entry ──
function calcConfidenceDecay(entryChecks = {}, currentChecks = {}) {
  const keys = Object.keys(entryChecks);
  if (!keys.length) return 0;
  const trueAtEntry = keys.filter(k => entryChecks[k]);
  if (!trueAtEntry.length) return 0;
  const stillTrue = trueAtEntry.filter(k => currentChecks[k]);
  const decayPct = Math.round((1 - stillTrue.length / trueAtEntry.length) * 100);
  return clamp(decayPct, 0, 100);
}

// ── Recovery Detector — is price bouncing back over the recent history
// window (market-state's per-symbol rolling history) after a dip? ──
function detectStrongContinuation({ pnlPct, symbolState, marketState, history = [] }) {
  if (!RUNNER_SHIELD_ENABLED || pnlPct == null || pnlPct < RUNNER_SHIELD_MIN_PCT) return false;
  const trends = [
    symbolState?.cvdMomentum?.trend,
    symbolState?.oiMomentum?.trend,
    marketState?.breadthMomentum?.trend,
    symbolState?.whaleMomentum?.trend,
  ];
  const accelerating = trends.filter(t => t === 'ACCELERATING' || t === 'IMPROVING').length;
  const prices = (history || []).map(h => h?.price).filter(v => v != null);
  const priceRising = prices.length >= 2 && prices[prices.length - 1] > prices[0];
  const riskOff = marketState?.marketRegime === 'RISK_OFF';
  return !riskOff && priceRising && accelerating >= RUNNER_MOMENTUM_MIN;
}

function detectRecovery(history = [], recoveryWaitMin) {
  if (history.length < 2) return { recovering: false, sustainedMin: 0 };
  const cutoff  = Date.now() - recoveryWaitMin * 60 * 1000;
  const inWindow = history.filter(h => h.t >= cutoff);
  const points   = inWindow.length >= 2 ? inWindow : history.slice(-2);
  const prices   = points.map(p => p.price).filter(v => v != null);
  if (prices.length < 2) return { recovering: false, sustainedMin: 0 };
  const recovering = prices[prices.length - 1] > prices[0];
  const sustainedMin = recovering
    ? Math.round((points[points.length - 1].t - points[0].t) / 60000)
    : 0;
  return { recovering, sustainedMin };
}

// ══════════════════════════════════════════════════════════════════════════════
// evaluatePosition — main entry point, called from position-monitor.js's
// monitorPositions() loop, once per open live/paper position per cycle.
//
// pos:            the tracked position object (positions.json entry) —
//                 must have pos.entrySnapshot (see buildEntrySnapshot above)
//                 and pos.entryPrice.
// currentEntry:   the symbol's current market-data.json entry (mData).
// symbolState:    market-state.json's symbols[sym] (may be undefined on
//                 the very first cycle after a fresh deploy — handled).
// marketState:    the top-level market-state.json object (for btcRiskScore
//                 / breadthMomentum / marketRegime).
// pnlPct:         current unrealized P&L %, already computed by the caller.
// ══════════════════════════════════════════════════════════════════════════════
export function evaluatePosition({ pos, currentEntry, symbolState, marketState, pnlPct }) {
  if (!ENABLED) return { action: 'HOLD', reason: 'intelligence disabled', skipped: true };
  const snap = pos.entrySnapshot;

  // ── No entry snapshot (e.g. manually adopted position) ──
  // Thesis/confidence comparisons are impossible without a captured entry
  // state, but falling-knife scoring only needs current market state, so
  // run a knife-only evaluation instead of skipping entirely.
  if (!snap) {
    if (!NO_SNAPSHOT_FALLBACK_ENABLED) {
      return { action: 'HOLD', reason: 'no entry snapshot (pre-dates this feature)', skipped: true };
    }

    const refAt = pos.liveOrder?.buyAt ?? pos.alertedAt ?? Date.now();
    const ageMin = (Date.now() - refAt) / 60000;
    if (ageMin < MIN_POSITION_AGE_MIN) {
      return { action: 'HOLD', reason: `position age ${ageMin.toFixed(1)}m < min ${MIN_POSITION_AGE_MIN}m (no entry snapshot)`, positionAgeMin: ageMin, skipped: true };
    }

    const fallingKnifeScore = calcFallingKnifeScore({
      btcRiskScore:     marketState?.btcRiskScore,
      cvdMomentum:      symbolState?.cvdMomentum,
      oiMomentum:       symbolState?.oiMomentum,
      breadthMomentum:  marketState?.breadthMomentum,
      whaleMomentum:    symbolState?.whaleMomentum,
      pnlPct,
    });

    const recovery = detectRecovery(symbolState?.history, RECOVERY_WAIT_MIN);
  const strongContinuation = detectStrongContinuation({
    pnlPct, symbolState, marketState, history: symbolState?.history,
  });
    const btcOkForRecovery = !REQUIRE_BTC_RECOVERY || (marketState?.btcRiskScore ?? 100) < FALLING_KNIFE_MAX;
    const recoveryConfirmed = recovery.recovering && recovery.sustainedMin >= RECOVERY_WAIT_MIN && btcOkForRecovery;
    const dynamicKnifeScore = recoveryConfirmed ? Math.round(fallingKnifeScore * 0.6) : fallingKnifeScore;

    let action = 'HOLD';
    if (dynamicKnifeScore >= NO_SNAPSHOT_EXIT_LEVEL)          action = 'EXIT';
    else if (dynamicKnifeScore >= NO_SNAPSHOT_REDUCE50_LEVEL) action = 'REDUCE_50';
    else if (dynamicKnifeScore >= NO_SNAPSHOT_REDUCE25_LEVEL) action = 'REDUCE_25';

    const reason = action === 'HOLD'
      ? `no entry snapshot — falling-knife-only score ${dynamicKnifeScore} below ${NO_SNAPSHOT_REDUCE25_LEVEL} threshold${recoveryConfirmed ? ' (recovery detected, risk softened)' : ''}`
      : `no entry snapshot — falling-knife-only score ${dynamicKnifeScore} ≥ ${action === 'EXIT' ? NO_SNAPSHOT_EXIT_LEVEL : action === 'REDUCE_50' ? NO_SNAPSHOT_REDUCE50_LEVEL : NO_SNAPSHOT_REDUCE25_LEVEL}${recoveryConfirmed ? ' (recovery softened but not enough)' : ''}`;

    return {
      action, reason, noSnapshotFallback: true,
      fallingKnifeScore, dynamicPositionRisk: dynamicKnifeScore, exitProbability: fallingKnifeScore,
      positionAgeMin: ageMin, recovery, isStaleAndFlat: false,
    };
  }

  const ageMin = (Date.now() - snap.at) / 60000;
  if (ageMin < MIN_POSITION_AGE_MIN) {
    return { action: 'HOLD', reason: `position age ${ageMin.toFixed(1)}m < min ${MIN_POSITION_AGE_MIN}m`, positionAgeMin: ageMin, skipped: true };
  }

  const d = currentEntry?.d || {};
  const currentThesisScore = calcThesisScore({
    conv: currentEntry?.conv, whaleScore: currentEntry?.whale?.score,
    bullConfCount: currentEntry?.bullConf, bias4h: d.bias4h,
  });
  const thesisDrop = snap.thesisScore - currentThesisScore; // positive = thesis weakening

  const fallingKnifeScore = calcFallingKnifeScore({
    btcRiskScore:     marketState?.btcRiskScore,
    cvdMomentum:      symbolState?.cvdMomentum,
    oiMomentum:       symbolState?.oiMomentum,
    breadthMomentum:  marketState?.breadthMomentum,
    whaleMomentum:    symbolState?.whaleMomentum,
    pnlPct,
  });

  const confidenceDecay = calcConfidenceDecay(snap.bullChecks, currentEntry?.bullChecks || {});

  const recovery = detectRecovery(symbolState?.history, RECOVERY_WAIT_MIN);
  const strongContinuation = detectStrongContinuation({
    pnlPct, symbolState, marketState, history: symbolState?.history,
  });

  // ── Breakout-failure check — see BREAKOUT_FAIL_BOOST comment above.
  // Only meaningful when the position was actually entered on a breakout
  // reclaim/imminent-trigger read AND the level was captured at entry
  // (older positions bought before this field existed simply won't have
  // snap.breakoutLevel, and this stays false/no-op for them). ──
  const enteredOnBreakout = snap.triggerStatus === 'BREAKOUT' || snap.triggerStatus === 'TRIGGERING';
  const currentPrice = currentEntry?.price ?? null;
  const breakoutFailed = enteredOnBreakout && snap.breakoutLevel != null && currentPrice != null && currentPrice < snap.breakoutLevel;

  // ── Exit Probability — composite of the three signals above ──
  let exitProbability =
      fallingKnifeScore * 0.45 +
      clamp(thesisDrop, 0, 100) * 0.35 +
      confidenceDecay * 0.20;

  if (breakoutFailed) exitProbability += BREAKOUT_FAIL_BOOST;

  // Market-regime awareness: a RISK_OFF regime raises exit probability
  // slightly (broad conditions working against the position); RISK_ON
  // dampens it slightly (isolated wobble more likely than a real turn).
  if (USE_MARKET_REGIME && marketState?.marketRegime === 'RISK_OFF') exitProbability += 8;
  if (USE_MARKET_REGIME && marketState?.marketRegime === 'RISK_ON')  exitProbability -= 6;

  // ── Staleness nudge — see constants block above ──
  const isStaleAndFlat = STALE_NUDGE_ENABLED && ageMin >= STALE_NUDGE_AGE_MIN && Math.abs(pnlPct ?? 0) < STALE_NUDGE_FLAT_PCT;
  if (isStaleAndFlat) exitProbability += STALE_NUDGE_AMOUNT;

  exitProbability = Math.round(clamp(exitProbability, 0, 100));

  // ── Dynamic Position Risk — Exit Probability, softened if a sustained
  // recovery is underway (don't punish a genuine bounce the same as a
  // knife still falling). REQUIRE_BTC_RECOVERY additionally requires BTC
  // itself not be in active panic (checked via marketState.btcRiskScore)
  // before letting the symbol's own bounce count. ──
  let dynamicPositionRisk = exitProbability;
  const btcOkForRecovery = !REQUIRE_BTC_RECOVERY || (marketState?.btcRiskScore ?? 100) < FALLING_KNIFE_MAX;
  const recoveryConfirmed = recovery.recovering && recovery.sustainedMin >= RECOVERY_WAIT_MIN && btcOkForRecovery;
  if (recoveryConfirmed) dynamicPositionRisk = Math.round(dynamicPositionRisk * 0.6);

  // ── Thesis invalidation — hard override, independent of the knife score ──
  if (thesisDrop > THESIS_INVALIDATE_SCORE) {
    return {
      action: 'EXIT',
      reason: `Thesis invalidated: entry score ${snap.thesisScore} → current ${currentThesisScore} (drop ${thesisDrop.toFixed(0)} > ${THESIS_INVALIDATE_SCORE})${breakoutFailed ? ' — price also back below entry breakout level' : ''}`,
      fallingKnifeScore, thesisDrop, currentThesisScore, confidenceDecay, exitProbability, dynamicPositionRisk, breakoutFailed,
      positionAgeMin: ageMin, recovery, isStaleAndFlat,
    };
  }

  // ── Confidence decay hard override ──
  if (!strongContinuation && confidenceDecay > CONFIDENCE_DECAY_MAX && fallingKnifeScore > PARTIAL_EXIT_LEVEL1) {
    return {
      action: 'REDUCE_50',
      reason: `Confidence decay ${confidenceDecay}% > ${CONFIDENCE_DECAY_MAX}% with falling-knife ${fallingKnifeScore}${breakoutFailed ? ' — price also back below entry breakout level' : ''}`,
      fallingKnifeScore, thesisDrop, currentThesisScore, confidenceDecay, exitProbability, dynamicPositionRisk, breakoutFailed,
      positionAgeMin: ageMin, recovery, isStaleAndFlat,
    };
  }

  // ── Primary decision ladder — dynamicPositionRisk (recovery-aware) ──
  let action = 'HOLD';
  if (dynamicPositionRisk >= EMERGENCY_EXIT_LEVEL)      action = 'EMERGENCY_EXIT';
  else if (!strongContinuation && dynamicPositionRisk >= PARTIAL_EXIT_LEVEL2)  action = 'REDUCE_50';
  else if (!strongContinuation && dynamicPositionRisk >= PARTIAL_EXIT_LEVEL1)  action = 'REDUCE_25';

  const reason = action === 'HOLD'
    ? `dynamicPositionRisk ${dynamicPositionRisk} below ${PARTIAL_EXIT_LEVEL1} threshold${recoveryConfirmed ? ' (recovery detected, risk softened)' : ''}${isStaleAndFlat ? ` (stale+flat nudge applied, +${STALE_NUDGE_AMOUNT})` : ''}${breakoutFailed ? ` (breakout-fail boost +${BREAKOUT_FAIL_BOOST} applied, still below threshold)` : ''}`
    : `dynamicPositionRisk ${dynamicPositionRisk} ≥ ${action === 'EMERGENCY_EXIT' ? EMERGENCY_EXIT_LEVEL : action === 'REDUCE_50' ? PARTIAL_EXIT_LEVEL2 : PARTIAL_EXIT_LEVEL1}${recoveryConfirmed ? ' (recovery softened but not enough)' : ''}${isStaleAndFlat ? ` (stale+flat nudge applied, +${STALE_NUDGE_AMOUNT})` : ''}${breakoutFailed ? ` (breakout-fail boost +${BREAKOUT_FAIL_BOOST} applied — price back below entry breakout level)` : ''}`;

  return {
    action, reason,
    fallingKnifeScore, thesisDrop, currentThesisScore, confidenceDecay, breakoutFailed,
    exitProbability, dynamicPositionRisk, positionAgeMin: ageMin, recovery, isStaleAndFlat, strongContinuation,
  };
}
