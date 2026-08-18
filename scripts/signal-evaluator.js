// ══════════════════════════════════════════════════════════════════════════════
// signal-evaluator.js — single shared SIGNAL / ENTRY_STATE classifier
//
// Implements the taxonomy from the "Signal / Market Guard / Buy-Alert
// Architecture" dev doc (§3-§5): one evaluator, consumed by every component
// that previously recreated this judgment independently —
//   - market-fetcher.js (writes signal+entryState into every market-data.json
//     entry once per fetch cycle — the single source of truth)
//   - leaderboard-scanner.js (Telegram scanner alert gate)
//   - js/app.js (GUI SIGNAL column reads the server-computed field instead of
//     recomputing its own classification client-side)
//
// SIGNAL values (mutually exclusive, execution intent):
//   BUY            — confirmed bullish, eligible for normal buy evaluation
//   EARLY BUY      — developing bullish, eligible for early/Alpha evaluation
//   WATCH          — interesting, insufficient confirmation, do not buy
//   WEAK           — deteriorating, not severe enough for AVOID, do not buy
//   AVOID          — clearly bearish, hard block new long
//   FALLING KNIFE  — severe bearish/high-risk deterioration, hard block new long
//
// ENTRY_STATE values (timing/extension modifier, independent of SIGNAL):
//   CLEAN, DIP BUY, BREAKOUT, RETEST, EXTENDED, CHASING, HIGH SHOCK
//
// This module is intentionally data-driven — no symbol-specific branches.
// It reads only fields already present on a scored entry (`d` from
// scoreSymbol()/scoreStock() in leaderboard-scanner.js, `buyIntel` from
// evaluateBuyReadiness() in buy-intelligence.js, and top-level conv/whale/
// bullConf already computed alongside it).
// ══════════════════════════════════════════════════════════════════════════════

// ── Tunable thresholds (env-overridable, same precedence model as the rest
//    of the runtime: GitHub Variables → this default) ──
const SIG_BULLCALL_BUY_MIN   = parseFloat(process.env.SIGNAL_BULLCALL_BUY_MIN   || '7');
const SIG_CONV_BUY_MIN       = parseFloat(process.env.SIGNAL_CONV_MIN           || '6'); // "Conv >= 6" in the doc's WATCH/BUY split
const SIG_WHALE_BUY_MIN      = parseFloat(process.env.SIGNAL_WHALE_BUY_MIN      || '50');
const SIG_BULLCALL_EARLY_MIN = parseFloat(process.env.SIGNAL_BULLCALL_EARLY_MIN || '6');
const SIG_CONV_EARLY_MIN     = parseFloat(process.env.SIGNAL_CONV_EARLY_MIN     || '4');

function isBull4h(bias4h)   { return bias4h === 'BULL 4H'; }
function isBearAny(bias)    { return bias === 'BEAR 4H' || bias === 'BEAR DAY' || bias === 'LEAN BEAR'; }
function isSevereBear(bias) { return bias === 'BEAR 4H' || bias === 'BEAR DAY'; }
function isBullDaily(biasDay) {
  return biasDay === 'BULL DAY' || biasDay === 'LEAN BULL' || biasDay === 'NEUTRAL';
}
function isLeanBullDaily(biasDay) {
  return biasDay === 'LEAN BULL' || biasDay === 'BULL DAY';
}

// ── ENTRY_STATE — timing/extension, independent of SIGNAL ──
// Priority: HIGH SHOCK (most urgent context) > CHASING (server-computed,
// already the source of truth for "don't chase this") > BREAKOUT > DIP BUY
// > EXTENDED > RETEST > CLEAN (default, nothing notable about entry timing).
function classifyEntryState(d, buyIntel) {
  const shock = d.shock || 0;
  if (buyIntel?.freshness?.knifePenalty > 0 || shock >= 2.5) return 'HIGH SHOCK';
  if ((buyIntel?.penalty ?? 0) > 0)                          return 'CHASING';
  const pullbackPct = buyIntel?.pullback?.pullbackPct;
  if (pullbackPct != null && pullbackPct <= 0 && shock >= 1.3) return 'BREAKOUT';
  if (d.oiDiv === 'DIP BUY')                                 return 'DIP BUY';
  if (buyIntel?.extension?.penalty > 0)                      return 'EXTENDED';
  if (pullbackPct != null && pullbackPct > 0 && pullbackPct < 1) return 'RETEST';
  return 'CLEAN';
}

// ── SIGNAL — execution-intent classification, per §5 of the dev doc ──
export function classifySignal(entry) {
  const d         = entry.d || {};
  const buyIntel  = d.buyIntel || null;
  const bias4h    = d.bias4h  || '—';
  const biasDay   = d.biasDay || '—';
  const conv      = entry.conv ?? d.conv ?? null;
  const bullCall  = entry.bullConf ?? 0;      // "BullCall" in the doc = bullConf count
  const whale     = entry.whale?.score ?? 0;
  const knifePenalty = buyIntel?.freshness?.knifePenalty ?? 0;
  const entryState = classifyEntryState(d, buyIntel);

  // FALLING KNIFE — severe negative momentum / extreme shock, checked first,
  // regardless of anything else (matches server's own knifePenalty semantics).
  if (knifePenalty > 0 && isSevereBear(bias4h)) {
    return { signal: 'FALLING KNIFE', entryState, reasons: ['knife penalty active', `bias4h=${bias4h}`] };
  }
  if (knifePenalty > 0 && (conv ?? 0) <= 0) {
    return { signal: 'FALLING KNIFE', entryState, reasons: ['knife penalty active', 'non-positive conviction'] };
  }

  // AVOID — clearly bearish structure (4H + daily), materially negative conviction.
  if (isSevereBear(bias4h) && isSevereBear(biasDay) && (conv ?? 0) < 0) {
    return { signal: 'AVOID', entryState, reasons: [`bias4h=${bias4h}`, `biasDay=${biasDay}`, `conv=${conv}`] };
  }
  if (isSevereBear(bias4h) && (conv ?? 0) <= -3) {
    return { signal: 'AVOID', entryState, reasons: [`bias4h=${bias4h}`, `conv=${conv}`] };
  }

  // BUY — strong bullish structure + confirmation. Entry-state disqualifiers
  // (CHASING / HIGH SHOCK) block the BUY path even if everything else clears,
  // matching the doc's "no disqualifying entry state" clause.
  const entryOkForBuy = entryState !== 'CHASING' && entryState !== 'HIGH SHOCK';
  if (
    isBull4h(bias4h) && isLeanBullDaily(biasDay) &&
    bullCall >= SIG_BULLCALL_BUY_MIN && (conv ?? 0) >= SIG_CONV_BUY_MIN &&
    whale >= SIG_WHALE_BUY_MIN && knifePenalty === 0 && entryOkForBuy
  ) {
    return { signal: 'BUY', entryState, reasons: ['bull 4H+daily', `bullCall=${bullCall}`, `conv=${conv}`, `whale=${whale}`] };
  }

  // EARLY BUY — developing bullish structure, lower bar than BUY.
  if (
    isBull4h(bias4h) && isLeanBullDaily(biasDay) &&
    bullCall >= SIG_BULLCALL_EARLY_MIN && (conv ?? 0) >= SIG_CONV_EARLY_MIN &&
    !isSevereBear(bias4h) && !isSevereBear(biasDay)
  ) {
    return { signal: 'EARLY BUY', entryState, reasons: ['bull 4H, lean bull daily', `bullCall=${bullCall}`, `conv=${conv}`] };
  }

  // WEAK — negative/deteriorating momentum, not severe enough for AVOID/knife.
  if ((conv ?? 0) < 0 || isBearAny(bias4h)) {
    return { signal: 'WEAK', entryState, reasons: [`conv=${conv}`, `bias4h=${bias4h}`] };
  }

  // WATCH — everything else: interesting but not confirmed (mixed trend,
  // weak conviction, insufficient confluence).
  return { signal: 'WATCH', entryState, reasons: [`bias4h=${bias4h}`, `biasDay=${biasDay}`, `conv=${conv}`] };
}

// Execution-eligibility helper — matches §3's "Execution intent" column so
// callers don't have to hardcode the BUY/EARLY BUY membership check twice.
export function isBuyEligible(signal) {
  return signal === 'BUY' || signal === 'EARLY BUY';
}
