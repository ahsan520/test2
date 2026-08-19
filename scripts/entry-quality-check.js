// ══════════════════════════════════════════════════════════════════════════════
// entry-quality-check.js — Entry Quality Check (post-5m-breakout gate)
//
// Implements the decision flow from "Leaderboard Decider / Buy Alert
// Improvement Notes v2":
//
//   FETCH → Market State → WATCH/EARLY SETUP → 5m BREAKOUT detected
//         → Entry Quality Check → PASS?  YES → BUY   NO → WAIT
//
// Architectural rule from that doc, enforced here: a strong Grade A signal
// does NOT directly authorize a buy. Grade (calcGrade, leaderboard-scanner.js)
// is a signal-strength/quality read; it is never consulted by this module.
// Every candidate — regardless of grade — must independently pass all eight
// checks below before leaderboard-decider.js is allowed to open a position.
//
// This module owns the eight named checks from the doc's diagram and always
// returns one of the doc's explicit blocker codes on failure:
//   ENTRY_EXTENDED   — breakout distance: already too far past the level
//   TRIGGER_STALE     — trigger age: breakout confirmed too long ago
//   IMPULSE_EXHAUSTED — impulse exhaustion: candle-run/shock already spent
//   BPP_FADING        — BPP direction: order-book (buy/sell pressure) proxy
//                        has turned against the breakout
//   CVD_WEAK          — CVD: tape isn't confirming (not one of the doc's
//                        named 6 codes, but the doc lists CVD as its own
//                        checklist row, so it gets its own code for the
//                        same reason volume-follow-through does)
//   VOLUME_THIN       — volume follow-through: 5m volume didn't expand
//   FAILED_BREAKOUT   — failed breakout: level reclaimed then lost
//   BTC_BLOCK         — BTC condition: BTC regime/Alpha-Exception veto
//
// Everything here is a THIN WRAPPER around existing, already-tested
// calculations (buy-intelligence.js's calcSpikeTrigger/evaluateBuyReadiness,
// signal-evaluator.js's classifyEntryState, market-guard.js's BTC checks).
// No thresholds are duplicated — this module only re-labels and re-groups
// existing pass/fail results into the doc's eight-row taxonomy and a single
// pass/fail decision, plus adds the two checks the doc calls for that did
// not exist anywhere yet (TRIGGER_STALE, BPP_FADING — see below).
// ══════════════════════════════════════════════════════════════════════════════

// ── Trigger age (NEW — did not previously exist anywhere in the pipeline) ──
// The pre-spike trigger layer (buy-intelligence.js) only ever reports a
// POINT-IN-TIME status (SETUP/TRIGGERING/BREAKOUT/FAILED); nothing tracked
// how long a symbol had been sitting in a confirmed BREAKOUT/TRIGGERING
// state. A breakout that confirmed 3+ Job B cycles ago (~45+ min at the
// ~15min cadence) and still hasn't been bought is a stale signal — the
// move it was flagging may already be over. Age is tracked per-pair in
// alertState (already loaded/saved every cycle by leaderboard-decider.js)
// so it survives across runs without a new state file.
const TRIGGER_STALE_ENABLED  = (process.env.EQ_TRIGGER_STALE_ENABLE || 'true') !== 'false';
const TRIGGER_STALE_MAX_MIN  = parseFloat(process.env.EQ_TRIGGER_STALE_MAX_MIN || '25'); // ~1.5 Job B cycles

// ── BPP — Book Pressure Proxy (NEW gate; the underlying obi/OBI order-book-
// imbalance number already existed — leaderboard-scanner.js's calcOBI — but
// nothing in the buy path ever gated on it). Deliberately lenient default:
// this is new in production, so it only blocks a CLEARLY fading book, not
// ordinary noise around zero. Raise EQ_BPP_BLOCK_THRESHOLD (less negative)
// to tighten it once there's a track record.
const BPP_ENABLED            = (process.env.EQ_BPP_ENABLE || 'true') !== 'false';
const BPP_BLOCK_THRESHOLD    = parseFloat(process.env.EQ_BPP_BLOCK_THRESHOLD || '-15'); // obi below this = net sell pressure

// ── CVD / volume-follow-through leniency ──
// Both are already baked into calcSpikeTrigger's BREAKOUT/TRIGGERING split
// (buy-intelligence.js) — a fully confirmed BREAKOUT already required
// cvdTrend==='up' and volumeExpansion. The RETEST exception (leaderboard-
// decider.js) deliberately allows a TRIGGERING status through without full
// confirmation on those two, so this module reports them as advisory
// (non-blocking) rather than a second hard block in that one case — it
// must not re-block something the RETEST exception was explicitly built to
// allow.
const CVD_WEAK_ENABLED       = (process.env.EQ_CVD_WEAK_ENABLE || 'true') !== 'false';
const VOLUME_THIN_ENABLED    = (process.env.EQ_VOLUME_THIN_ENABLE || 'true') !== 'false';

function pass(reason) { return { pass: true, code: null, reason }; }
function fail(code, reason) { return { pass: false, code, reason }; }

// ── Trigger-age tracking, persisted in alertState[pair].triggerFirstSeenAt ──
// Call once per entry, per cycle, right before the Entry Quality Check
// itself runs (i.e. only once a 5m breakout has actually been detected —
// matches the doc's flow ordering). Resets the clock the moment the
// trigger drops out of BREAKOUT/TRIGGERING (a fresh setup starting over
// should not inherit a stale age from an unrelated earlier trigger).
export function trackTriggerAge(alertState, pair, triggerStatus) {
  const active = triggerStatus === 'BREAKOUT' || triggerStatus === 'TRIGGERING';
  const rec = alertState[pair] || (alertState[pair] = {});
  if (!active) {
    delete rec.triggerFirstSeenAt;
    return null;
  }
  if (!rec.triggerFirstSeenAt) rec.triggerFirstSeenAt = Date.now();
  rec.lastSeenAt = Date.now(); // keep alive in alertState's TTL prune while trigger is active
  return (Date.now() - rec.triggerFirstSeenAt) / 60000; // minutes
}

// ── The Entry Quality Check ─────────────────────────────────────────────
// entry:      market-data.json entry for this pair (top-level triggerStatus/
//             entryState/d/capBuy, matching market-fetcher.js's shape)
// pair:       symbol string, for trigger-age lookups
// alertState: mutable, persisted across cycles (leaderboard-decider.js owns
//             load/save) — used only for trigger-age tracking here
// btcCheck:   { pass, reason } precomputed by the caller from
//             market-guard.js's BTC regime / Alpha Exception / Fear&Greed
//             divergence logic (kept in leaderboard-decider.js since it
//             needs guard/market/positions context this module doesn't
//             have) — merged in here so the returned object still reports
//             all eight rows and a single pass/fail.
export function checkEntryQuality({ entry, pair, alertState, isCapBuy = false, btcCheck = null }) {
  const d = entry.d || {};
  const triggerStatus = entry.triggerStatus ?? null;
  const entryState    = entry.entryState ?? 'CLEAN';
  const trigger        = d.trigger || null;

  const retestException = entryState === 'RETEST' && triggerStatus === 'TRIGGERING';

  const checks = {};

  // 1 ── Breakout distance (already too far past the level) ──
  // CAP BUY is exempt — it's an extreme-shock event by definition, "already
  // moving fast" is the premise, not a disqualifier (see buy-intelligence.js).
  checks.breakoutDistance = isCapBuy
    ? pass('CAP BUY — extension is the premise, exempt')
    : entryState === 'CHASING'
      ? fail('ENTRY_EXTENDED', 'already extended past the breakout — buying the exhaustion, not the move')
      : pass(entryState === 'EXTENDED' ? 'RSI-extended but not yet chase-blocked' : 'not extended');

  // 2 ── Trigger age (breakout confirmed too long ago) ──
  const ageMin = trackTriggerAge(alertState, pair, triggerStatus);
  checks.triggerAge = (!TRIGGER_STALE_ENABLED || ageMin == null)
    ? pass('trigger-age check disabled or not yet in a BREAKOUT/TRIGGERING state')
    : ageMin > TRIGGER_STALE_MAX_MIN
      ? fail('TRIGGER_STALE', `breakout first confirmed ${ageMin.toFixed(0)} min ago (max ${TRIGGER_STALE_MAX_MIN}) — signal may already be over`)
      : pass(`breakout is ${ageMin.toFixed(0)} min old (max ${TRIGGER_STALE_MAX_MIN})`);

  // 3 ── Impulse exhaustion (candle-run chase / knife / high-shock-unconfirmed) ──
  const freshnessPenalty = (d.buyIntel?.freshness?.penalty ?? 0) + (d.buyIntel?.freshness?.knifePenalty ?? 0);
  checks.impulseExhaustion = isCapBuy
    ? pass('CAP BUY — shock is the premise, exempt')
    : entryState === 'HIGH SHOCK' && triggerStatus !== 'BREAKOUT'
      ? fail('IMPULSE_EXHAUSTED', `HIGH SHOCK entry (elevated volatility) without a fully confirmed BREAKOUT (trigger=${triggerStatus ?? 'n/a'}) — riskiest pairing, not a safer one`)
      : freshnessPenalty > 0
        ? pass(`candle-run/knife penalty present (${freshnessPenalty}) but below hard-block threshold`)
        : pass('no impulse-exhaustion signal');

  // 4 ── BPP direction (order-book buy/sell pressure proxy — obi) ──
  const obi = d.obi ?? 0;
  checks.bpp = !BPP_ENABLED
    ? pass('BPP check disabled')
    : obi <= BPP_BLOCK_THRESHOLD
      ? fail('BPP_FADING', `order-book pressure reads ${obi.toFixed ? obi.toFixed(1) : obi} (≤ ${BPP_BLOCK_THRESHOLD}) — book has turned against the breakout`)
      : pass(`order-book pressure ${obi.toFixed ? obi.toFixed(1) : obi} — not fading`);

  // 5 ── CVD (tape confirmation) — advisory during a RETEST exception ──
  const cvdUp = d.cvdTrend === 'up';
  checks.cvd = (!CVD_WEAK_ENABLED || retestException || triggerStatus == null)
    ? pass(retestException ? 'RETEST exception — CVD advisory only, not required' : 'CVD check disabled or trigger not yet evaluated')
    : cvdUp
      ? pass('CVD trend up')
      : fail('CVD_WEAK', 'CVD trend is not up — tape not confirming the breakout');

  // 6 ── Volume follow-through — advisory during a RETEST exception ──
  const volExpansion = trigger?.volumeExpansion ?? false;
  checks.volumeFollowThrough = (!VOLUME_THIN_ENABLED || retestException || triggerStatus == null)
    ? pass(retestException ? 'RETEST exception — volume advisory only, not required' : 'volume check disabled or trigger not yet evaluated')
    : volExpansion
      ? pass('5m volume expanded on the breakout')
      : fail('VOLUME_THIN', '5m volume did not expand — breakout lacks follow-through');

  // 7 ── Failed breakout (level reclaimed then lost) ──
  checks.failedBreakout = triggerStatus === 'FAILED'
    ? fail('FAILED_BREAKOUT', 'level was reclaimed on 5m then lost — failed breakout, blocks regardless of score/whale/CVD')
    : pass('no failed-breakout signal');

  // 8 ── BTC condition — precomputed by the caller (market-guard.js context) ──
  checks.btcCondition = btcCheck == null
    ? pass('BTC condition not evaluated by caller')
    : btcCheck.pass
      ? pass(btcCheck.reason || 'BTC condition clear')
      : fail('BTC_BLOCK', btcCheck.reason || 'BTC regime/condition blocked');

  const blockers = Object.values(checks).filter(c => !c.pass).map(c => ({ code: c.code, reason: c.reason }));

  return {
    pass: blockers.length === 0,
    blockers,
    checks,
  };
}
