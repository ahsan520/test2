// ══════════════════════════════════════════════════════════════════════════════
// market-intelligence.js — Market Intelligence Engine (v15 design doc, Buy-side)
//
// Sits between market-fetcher.js (writes market-data.json) and everything
// downstream (leaderboard-scanner/decider, market-guard). Never modifies
// market-data.json — instead maintains its own file, market-state.json,
// holding a rolling history (last 4 fetch cycles ≈ 20 min at the 5-min
// fetch cadence) plus a set of derived, slower-moving metrics computed
// from that history:
//
//   BTC Risk Score        — 0-100 composite risk read on the whole market,
//                            proxied off BTC (see calcBtcRiskScore below).
//   Momentum Slope        — direction/steepness of price over the last
//                            4 fetch cycles, per symbol.
//   CVD Momentum          — is CVD trend accelerating, flat, or fading.
//   OI Momentum           — proxied from funding-rate trend, since raw
//                            open-interest isn't fetched anywhere in this
//                            codebase today (see note on calcOiMomentum).
//   Breadth Score/Momentum— % of the crypto watchlist in a bullish 4H
//                            posture right now, and whether that % is
//                            rising or falling over the rolling window.
//   Whale Momentum        — is whale.score rising or falling per symbol.
//   Relative Strength     — reuses market-guard.js's calcRelativeStrength
//                            (kept in one place; not duplicated here).
//   Setup Persistence     — reuses bull4hCount already maintained by
//                            market-fetcher.js.
//   Market Regime         — single label derived from BTC Risk Score +
//                            breadth (RISK_ON / NEUTRAL / RISK_OFF).
//   Dynamic bull4hCount    — pass-through, single source of truth stays
//                            market-fetcher.js's buildEntry().
//
// Risk bands (per design doc):
//   0-30  = Buy
//   30-50 = Reduce size
//   50-70 = Watch
//   >70   = Block buys
// ══════════════════════════════════════════════════════════════════════════════

const HISTORY_LEN = parseInt(process.env.MI_HISTORY_LEN || '4', 10); // ≈20 min at 5-min cadence

// ── Risk band classification — shared by BTC risk score and per-symbol use ──
// ── Risk band terminology ──
// Previously used BUY/REDUCE/WATCH/BLOCK — overloading "BUY" on a risk
// score reads as market permission ("Risk score: 0 (BUY)") when it's really
// only describing BTC risk, one input among several (breadth, relative
// strength, bull-4H persistence, etc. — see checkMarketIntelligenceGate in
// market-guard.js) that determine whether a buy is actually allowed. Pure
// risk-severity language avoids that ambiguity; actual buy permission is
// now a separate field (see computeBuyStatus below / market-state.json's
// buyStatus).
export function getRiskBand(score) {
  if (score == null || isNaN(score)) return { band: 'UNKNOWN', action: 'watch' };
  if (score <= 20) return { band: 'LOW RISK',  action: 'buy' };
  if (score <= 40) return { band: 'MODERATE',  action: 'buy' };
  if (score <= 60) return { band: 'ELEVATED',  action: 'reduce_size' };
  if (score <= 80) return { band: 'HIGH',      action: 'watch' };
  return             { band: 'EXTREME',  action: 'block_buys' };
}

// ── BUY STATUS — portfolio-level buy permission, separate from risk band ──
// Mirrors the two portfolio-wide (non-per-candidate) checks from
// checkMarketIntelligenceGate() in market-guard.js — BTC risk ceiling and
// market breadth — using the SAME env vars so the effective threshold is
// guaranteed identical under the "GitHub Variables override YAML defaults"
// precedence model, without market-intelligence.js needing to import
// market-guard.js. This is deliberately NOT the full per-candidate gate
// (relative strength, bull-4H persistence, breadth exception, etc. all
// still require a specific symbol) — it's the always-on portfolio-wide
// subset, exposed so the GUI can show real buy permission instead of
// inferring it from the risk score alone (§6/§7 of the architecture doc).
const BUY_STATUS_BTC_RISK_MAX = parseFloat(process.env.BUY_BTC_RISK_MAX || '60');
const BUY_STATUS_MIN_BREADTH  = parseFloat(process.env.BUY_MIN_BREADTH  || '60');

// ── Runtime config precedence debug snapshot (§11 of the architecture doc) ──
// GitHub Variables override YAML defaults, but that resolution happens at
// the Actions-runner/YAML level (`${{ vars.X || 'default' }}`) — by the
// time this script runs, process.env.X is already the single resolved
// value and there is no way to tell FROM HERE whether it came from an
// actual repo Variable or the YAML fallback. So this snapshot reports what
// this process is actually running with (the thing that matters for
// debugging "why did it behave that way"), not a verified claim about
// where each value originated — hence 'runtime_env', not the doc's
// 'github_variables' label, which would overstate what this can confirm.
function snapshotRuntimeConfig() {
  return {
    config: {
      BUY_MIN_BREADTH:            process.env.BUY_MIN_BREADTH            ?? null,
      BUY_BTC_RISK_MAX:           process.env.BUY_BTC_RISK_MAX           ?? null,
      BUY_BULL4H_COUNT_MIN:       process.env.BUY_BULL4H_COUNT_MIN       ?? null,
      BTC_ALPHA_BULL4H_COUNT_MIN: process.env.BTC_ALPHA_BULL4H_COUNT_MIN ?? null,
      EXEC_MIN_GRADE:             process.env.EXEC_MIN_GRADE             ?? null,
      LB_MIN_SCORE:               process.env.LB_MIN_SCORE               ?? null,
    },
    configSource: 'runtime_env', // resolved value this process saw — see comment above
  };
}

function computeBuyStatus(btcRiskScore, btcRiskBand, breadthScore) {
  const btcRiskGate = btcRiskScore == null ? 'UNKNOWN' : (btcRiskScore <= BUY_STATUS_BTC_RISK_MAX ? 'PASS' : 'FAIL');
  const breadthGate = breadthScore == null ? 'UNKNOWN' : (breadthScore >= BUY_STATUS_MIN_BREADTH ? 'PASS' : 'FAIL');

  const gatesReady = btcRiskGate !== 'UNKNOWN' && breadthGate !== 'UNKNOWN';
  const bothPass   = btcRiskGate === 'PASS' && breadthGate === 'PASS';

  let status, canBuyNormally, reason;
  if (!gatesReady) {
    status = 'UNKNOWN'; canBuyNormally = false; reason = 'Market state not ready yet';
  } else if (bothPass) {
    status = 'OPEN'; canBuyNormally = true; reason = null;
  } else {
    // A candidate can still pass via the relative-strength/breadth
    // exceptions in checkMarketIntelligenceGate — this portfolio-level
    // view can't evaluate those (they're per-symbol), so this reads as
    // CONDITIONAL rather than a flat BLOCKED.
    status = 'CONDITIONAL'; canBuyNormally = false;
    reason = btcRiskGate === 'FAIL'
      ? `BTC risk score ${btcRiskScore} > ${BUY_STATUS_BTC_RISK_MAX} (${btcRiskBand})`
      : `Breadth ${breadthScore}% < required ${BUY_STATUS_MIN_BREADTH}%`;
  }

  return { status, canBuyNormally, reason, btcRiskGate, breadthGate };
}

// ── Small helpers ──
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function slope(values) {
  // Simple linear-regression-style slope over an evenly-spaced series,
  // normalized to %/cycle so it's comparable across symbols of any price.
  const xs = values.map((_, i) => i);
  const n  = values.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const m = den === 0 ? 0 : num / den;
  return meanY !== 0 ? parseFloat(((m / meanY) * 100).toFixed(4)) : 0;
}

// ── Raw (unnormalized) slope — same linear regression as slope() above,
// but returns the actual per-cycle rate of change instead of dividing by
// the series' mean. slope()'s mean-normalization works fine for prices
// (always positive, never near zero) but is unsafe for values that
// oscillate around and cross zero — funding rate is exactly that case.
// A funding rate history like [0.0001, -0.0004] has a mean near zero, so
// slope()'s (m / meanY) * 100 blows up into huge, unstable numbers purely
// from the denominator being tiny — not from any real momentum change.
// Used by calcOiMomentum below; slope() is left untouched for its other
// callers (price, whale score, breadth), which don't have this problem. ──
function rawSlope(values) {
  const xs = values.map((_, i) => i);
  const n  = values.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const m = den === 0 ? 0 : num / den;
  return parseFloat(m.toFixed(5));
}

function trendLabel(m) {
  if (m > 0.05)  return 'ACCELERATING';
  if (m < -0.05) return 'FADING';
  return 'FLAT';
}

// Funding rate moves in thousandths of a percent per cycle under normal
// conditions (e.g. observed live range ~0.00001% to ~0.0003%/cycle, IMX's
// -0.00075% being the most extreme seen), nowhere near slope()'s 0.05
// threshold (tuned for %-of-mean price/whale-score movement) — so this
// needs its own, much smaller threshold on the RAW %-point change.
function frTrendLabel(m) {
  if (m > 0.0001)  return 'ACCELERATING';
  if (m < -0.0001) return 'FADING';
  return 'FLAT';
}

// ── BTC Risk Score — 0 (safe to buy) → 100 (block everything) ──
// Composite of: BTC's own 4h/day bias, short-term (15m) momentum, recent
// volatility (candle range), and Fear & Greed. Each component contributes
// points toward "risk", summed and clamped to 0-100. Deliberately reuses
// fields market-fetcher.js already computes each cycle (global.*), no new
// fetches needed.
function calcBtcRiskScore(global = {}, btcEntry = {}) {
  let risk = 30; // neutral baseline

  const bias4h  = btcEntry?.d?.bias4h  || global.btcBias4h  || '';
  const biasDay = btcEntry?.d?.biasDay || global.btcBiasDay || '';
  const emaTrend= btcEntry?.d?.emaTrend|| global.btcEmaTrend|| '';
  const chg15m  = global.btcChg15m;
  const vol     = global.btcVolatility;
  const fg      = global.fearGreed;

  if (bias4h.includes('BEAR'))       risk += bias4h.includes('LEAN') ? 10 : 20;
  else if (bias4h.includes('BULL'))  risk -= bias4h.includes('LEAN') ? 8  : 16;

  if (biasDay.includes('BEAR'))      risk += 8;
  else if (biasDay.includes('BULL')) risk -= 8;

  if (emaTrend === 'BELOW') risk += 8;
  else if (emaTrend === 'ABOVE') risk -= 6;

  if (chg15m != null) {
    if (chg15m <= -3)      risk += 25;
    else if (chg15m <= -1) risk += 12;
    else if (chg15m >= 1)  risk -= 6;
  }

  if (vol != null) {
    if (vol >= 8)      risk += 15;
    else if (vol >= 4)  risk += 7;
  }

  if (fg != null) {
    if (fg <= 20)      risk += 15; // extreme fear = high risk of further downside/illiquidity
    else if (fg <= 30) risk += 6;
    else if (fg >= 75) risk += 4;  // extreme greed carries its own (blow-off) risk, smaller weight
  }

  return clamp(Math.round(risk), 0, 100);
}

// ── Breadth — % of scored crypto symbols currently in a bullish 4H posture ──
function calcBreadth(symbols = {}) {
  const cryptoEntries = Object.values(symbols).filter(s => s.assetType === 'crypto' && s.d);
  if (!cryptoEntries.length) return { score: null, bullCount: 0, total: 0 };
  const bullCount = cryptoEntries.filter(s => (s.d.bias4h || '').includes('BULL')).length;
  const score = Math.round((bullCount / cryptoEntries.length) * 100);
  return { score, bullCount, total: cryptoEntries.length };
}

// ── OI Momentum (proxy) ──
// Uses funding-rate direction as a proxy for true OI momentum (see note
// on calcOiMomentum below). Uses rawSlope/frTrendLabel, not slope()'s
// %-of-mean normalization — funding rate oscillates around and crosses
// zero, which makes a mean-relative slope wildly unstable (a symbol
// whose fr history is [0.00008, -0.00036] has a near-zero mean, so
// dividing by it produces huge, meaningless swings unrelated to the
// actual size of the move).
// NOTE: this codebase does not fetch raw open-interest anywhere today —
// leaderboard-scanner.js only pulls funding rate (d.fr) from the futures
// premiumIndex endpoint. Funding-rate direction is a reasonable proxy for
// OI-driven momentum (rising funding while price rises ≈ longs piling in,
// i.e. OI building on the long side) but it is NOT the same signal as
// true OI. Flagged as `proxy: true` in the output so callers/dashboard
// can label it honestly rather than presenting it as real OI data.
function calcOiMomentum(frHistory) {
  if (frHistory.length < 2) return { momentum: 0, trend: 'FLAT', proxy: true };
  const m = rawSlope(frHistory);
  return { momentum: m, trend: frTrendLabel(m), proxy: true };
}

// ── Per-symbol history push/roll ──
function pushHistory(prevHist, entry) {
  const hist = Array.isArray(prevHist) ? prevHist.slice() : [];
  hist.push({
    t:      entry.updatedAt,
    price:  entry.price,
    whale:  entry.whale?.score ?? null,
    fr:     entry.d?.fr ?? null,
    cvd:    entry.d?.cvdTrend ?? null,
    conv:   entry.conv ?? null,
  });
  while (hist.length > HISTORY_LEN) hist.shift();
  return hist;
}

// ── CVD momentum — counts consecutive same-direction cvdTrend readings
// within the rolling window, signed by direction (mirrors bull4hCount's
// "persistence" pattern, just scoped to the shorter market-state window
// instead of unbounded). ──
function calcCvdMomentum(hist) {
  if (!hist.length) return { streak: 0, trend: 'FLAT' };
  let streak = 0;
  const latestDir = hist[hist.length - 1].cvd;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].cvd === latestDir) streak++;
    else break;
  }
  if (latestDir === 'up')   return { streak, trend: 'ACCELERATING' };
  if (latestDir === 'down') return { streak, trend: 'FADING' };
  return { streak, trend: 'FLAT' };
}

// ══════════════════════════════════════════════════════════════════════════════
// computeMarketState — main entry point, called once per Job A fetch cycle
// (from market-fetcher.js, right after market-data.json is assembled).
//
// prevState: previously-saved market-state.json (or {} on first run)
// market:    the freshly-built { fetchedAt, global, symbols } object,
//            i.e. exactly what market-fetcher.js is about to save as
//            market-data.json — passed in-memory, no extra file read.
// ══════════════════════════════════════════════════════════════════════════════
export function computeMarketState(prevState = {}, market = {}) {
  const { global = {}, symbols = {}, fetchedAt = Date.now() } = market;
  const prevSymbols = prevState.symbols || {};

  const btcEntry     = symbols['BTCUSDT'] || {};
  const btcRiskScore = calcBtcRiskScore(global, btcEntry);
  const btcRiskBand  = getRiskBand(btcRiskScore);

  const breadth        = calcBreadth(symbols);
  const prevBreadth    = prevState.breadth?.score ?? null;
  const breadthMomentum= (breadth.score != null && prevBreadth != null)
    ? { delta: breadth.score - prevBreadth, trend: trendLabel((breadth.score - prevBreadth) / 10) }
    : { delta: 0, trend: 'FLAT' };

  // ── Market regime — single label combining BTC risk + breadth ──
  let marketRegime = 'NEUTRAL';
  if (btcRiskScore <= 30 && (breadth.score ?? 50) >= 55) marketRegime = 'RISK_ON';
  else if (btcRiskScore > 60 || (breadth.score ?? 50) <= 35) marketRegime = 'RISK_OFF';

  const outSymbols = {};
  for (const [sym, entry] of Object.entries(symbols)) {
    if (entry.assetType !== 'crypto') continue; // Phase 1 scope: crypto only, per design doc
    const prevSymState = prevSymbols[sym] || {};
    const hist = pushHistory(prevSymState.history, entry);

    const priceHist  = hist.map(h => h.price).filter(v => v != null);
    const whaleHist  = hist.map(h => h.whale).filter(v => v != null);
    const frHist     = hist.map(h => h.fr).filter(v => v != null);

    const momentumSlope  = slope(priceHist);
    const whaleMomentum  = whaleHist.length >= 2
      ? { delta: whaleHist[whaleHist.length - 1] - whaleHist[0], trend: trendLabel(slope(whaleHist) / 5) }
      : { delta: 0, trend: 'FLAT' };
    const cvdMomentum = calcCvdMomentum(hist);
    const oiMomentum  = calcOiMomentum(frHist);

    outSymbols[sym] = {
      history:        hist,
      momentumSlope,                       // %/cycle, price
      momentumTrend:  trendLabel(momentumSlope),
      cvdMomentum,
      oiMomentum,
      whaleMomentum,
      setupPersistence: entry.bull4hCount ?? 0, // pass-through, single source of truth stays market-fetcher.js
      updatedAt:       entry.updatedAt,
    };
  }

  const buyStatus = computeBuyStatus(btcRiskScore, btcRiskBand.band, breadth.score);

  return {
    fetchedAt,
    btcRiskScore,
    btcRiskBand:   btcRiskBand.band,
    btcRiskAction: btcRiskBand.action,
    marketRegime,
    breadth: { score: breadth.score, bullCount: breadth.bullCount, total: breadth.total },
    breadthMomentum,
    buyStatus, // { status, canBuyNormally, reason, btcRiskGate, breadthGate } — see computeBuyStatus above
    ...snapshotRuntimeConfig(), // { config, configSource } — see snapshotRuntimeConfig above
    symbols: outSymbols,
  };
}
