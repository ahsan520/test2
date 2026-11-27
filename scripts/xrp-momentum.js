// ══════════════════════════════════════════════════════════════════════════════
// xrp-momentum.js — XRP-only 5m momentum BUY / SELL alerts, PRICE-BASED.
//
// No indicators (no Supertrend / CVD / signal flags) — everything is read from
// the 5m price candles themselves. XRP is fee-free, so the bar is low.
//
// BUY alert  = N consecutive CLOSED 5m candles each higher than the last, each
//              with a higher low, live price still above the last close, AND not
//              a falling-knife bounce (see xrpKnifeReasons).
// SELL alert = mirror: N lower closes, lower highs, price still below last close.
//
// Anti-chase (BUY): needs a real dip first, run must start near the dip low, and must
// not already be a spike (move cap, stretch above 1h average, blow-off candle).
//
// Falling-knife = a green run that has only retraced a small part of the drop
// that came before it, or is still far below the recent high. Price-only test:
//   recovery = (price - low2h) / (high2h - low2h)  must be >= MIN_RECOVERY_PCT
//   (only checked when the 2h drop was at least MIN_DROP_PCT)
//   pullback = % below the 2h high               must be <= MAX_PULLBACK_PCT
//
// Alert only — never executes. Fires once per streak (keyed on its first
// candle). Streak data is computed in leaderboard-scanner.js from the k5
// candles already fetched — no extra API call.
// ══════════════════════════════════════════════════════════════════════════════

export const XRP_MOM_ENABLED   = (process.env.XRP_MOM_ENABLE ?? 'true') !== 'false';
export const XRP_MOM_PAIR      = process.env.XRP_MOM_PAIR || 'XRPUSDT';
const STREAK_MIN               = parseInt(process.env.XRP_MOM_STREAK_MIN || '3', 10);          // consecutive closed 5m candles
const MIN_MOVE_PCT             = parseFloat(process.env.XRP_MOM_MIN_MOVE_PCT || '0.15');       // total move across the streak
const COOLDOWN_MIN             = parseInt(process.env.XRP_MOM_COOLDOWN_MIN || '10', 10);       // gap between same-side alerts
const SELL_ENABLED             = (process.env.XRP_MOM_SELL_ENABLE ?? 'true') !== 'false';
const REQUIRE_HL_LH            = (process.env.XRP_MOM_REQUIRE_HL_LH ?? 'true') !== 'false';    // higher lows (buy) / lower highs (sell)
const MIN_DROP_PCT             = parseFloat(process.env.XRP_MOM_MIN_DROP_PCT || '0.4');        // 2h drop big enough to run the recovery test
const MIN_RECOVERY_PCT         = parseFloat(process.env.XRP_MOM_MIN_RECOVERY_PCT || '50');     // % of that drop price must have won back
const MAX_PULLBACK_PCT         = parseFloat(process.env.XRP_MOM_MAX_PULLBACK_PCT || '0.5');    // max % below the 2h high
// ── Anti-chase guards (BUY only): buy the turn off a dip, not a run that already spiked ──
const REQUIRE_DIP              = (process.env.XRP_MOM_REQUIRE_DIP ?? 'true') !== 'false';      // a real dip (>= MIN_DROP_PCT) must have happened first
const DIP_ZONE_PCT             = parseFloat(process.env.XRP_MOM_DIP_ZONE_PCT || '0.5');        // run must START within this % of the 2h low
const MAX_MOVE_PCT             = parseFloat(process.env.XRP_MOM_MAX_MOVE_PCT || '0.9');        // run already up more than this = spiked, skip
const MAX_EXT_PCT              = parseFloat(process.env.XRP_MOM_MAX_EXT_PCT || '0.4');         // max % above the 1h (12-bar) average close
const MAX_CANDLE_X             = parseFloat(process.env.XRP_MOM_MAX_CANDLE_X || '3');          // blow-off candle: range > X * normal range
const LOOKBACK_BARS            = 24;                                                           // 24 x 5m = 2h

// Raw 5m klines ([openTime, o, h, l, close, vol], oldest→newest). Drops the forming candle.
export function calcXrpStreak(k5) {
  if (!Array.isArray(k5) || k5.length < 6) return null;
  const closed = k5.slice(0, -1);
  const closes = closed.map(c => parseFloat(c[4]));
  const highs  = closed.map(c => parseFloat(c[2]));
  const lows   = closed.map(c => parseFloat(c[3]));
  const n = closes.length;

  let rising = 0, falling = 0;
  for (let i = n - 1; i > 0; i--) { if (closes[i] > closes[i - 1]) rising++;  else break; }
  for (let i = n - 1; i > 0; i--) { if (closes[i] < closes[i - 1]) falling++; else break; }

  const len = Math.max(rising, falling);
  const baseIdx = n - 1 - len;                         // candle just BEFORE the streak
  const movePct = len > 0 && closes[baseIdx] > 0
    ? ((closes[n - 1] - closes[baseIdx]) / closes[baseIdx]) * 100 : 0;

  // Structure inside the streak: every candle's low above the previous low (buy) /
  // every high below the previous high (sell).
  let higherLows = len > 0, lowerHighs = len > 0;
  for (let i = baseIdx + 1; i < n; i++) {
    if (!(lows[i]  > lows[i - 1]))  higherLows = false;
    if (!(highs[i] < highs[i - 1])) lowerHighs = false;
  }

  // 2h range: the high, then the lowest low AFTER that high (the drop it led to).
  const start = Math.max(0, n - LOOKBACK_BARS);
  let hiIdx = start;
  for (let i = start; i < n; i++) if (highs[i] >= highs[hiIdx]) hiIdx = i;
  const high2h = highs[hiIdx];
  const low2h  = Math.min(...lows.slice(hiIdx));
  const dropPct = high2h > 0 ? ((high2h - low2h) / high2h) * 100 : 0;
  const rangeLow = Math.min(...lows.slice(start));   // display only
  const lastClose = closes[n - 1];
  const recoveryPct = high2h > low2h ? ((lastClose - low2h) / (high2h - low2h)) * 100 : 100;
  const pullbackPct = high2h > 0 ? ((high2h - lastClose) / high2h) * 100 : 0;

  // Anti-chase measures (price only)
  const base = len > 0 ? closes[baseIdx] : lastClose;
  const baseOffLowPct = rangeLow > 0 ? ((base - rangeLow) / rangeLow) * 100 : 0;          // how far above the dip low the run STARTED
  const mean12 = closes.slice(-12).reduce((a, b) => a + b, 0) / Math.min(12, n);
  const extPct = mean12 > 0 ? ((lastClose - mean12) / mean12) * 100 : 0;                  // stretch above the 1h average
  // true range per candle: includes the jump from the previous close, so a gap/spike candle is measured properly
  const ranges = closed.map((c, i) => Math.max(highs[i] - lows[i], i > 0 ? Math.abs(closes[i] - closes[i - 1]) : 0));
  const preR = ranges.slice(Math.max(0, baseIdx - 11), baseIdx + 1);
  const preAvg = preR.length ? preR.reduce((a, b) => a + b, 0) / preR.length : 0;
  const runMax = len > 0 ? Math.max(...ranges.slice(baseIdx + 1)) : 0;
  const candleX = preAvg > 0 ? runMax / preAvg : 1;                                        // biggest run candle vs normal candle
  return {
    rising, falling, higherLows, lowerHighs,
    baseOffLowPct: +baseOffLowPct.toFixed(3), extPct: +extPct.toFixed(3), candleX: +candleX.toFixed(2),
    high2h, low2h, rangeLow, dropPct: +dropPct.toFixed(3),
    recoveryPct: +recoveryPct.toFixed(1), pullbackPct: +pullbackPct.toFixed(3),
    lastClose, movePct: +movePct.toFixed(3),
    streakStartTs: len > 0 ? parseInt(closed[baseIdx + 1][0], 10) : null,
    lastClosedTs: parseInt(closed[n - 1][0], 10),
  };
}

// Reasons the BUY is a falling-knife bounce ([] = clear). Price only.
export function xrpKnifeReasons(s) {
  const r = [];
  if (s.pullbackPct > MAX_PULLBACK_PCT) r.push(`${s.pullbackPct}% below 2h high (max ${MAX_PULLBACK_PCT}%)`);
  if (s.dropPct >= MIN_DROP_PCT && s.recoveryPct < MIN_RECOVERY_PCT)
    r.push(`only ${s.recoveryPct}% of the ${s.dropPct}% drop recovered (need ${MIN_RECOVERY_PCT}%)`);
  return r;
}

// Reasons the BUY is chasing an already-spiked run ([] = early enough). Price only.
export function xrpChaseReasons(s) {
  const r = [];
  if (REQUIRE_DIP && s.dropPct < MIN_DROP_PCT) r.push(`no dip first (2h drop ${s.dropPct}% < ${MIN_DROP_PCT}%)`);
  if (REQUIRE_DIP && s.baseOffLowPct > DIP_ZONE_PCT) r.push(`run started ${s.baseOffLowPct}% above the dip low (max ${DIP_ZONE_PCT}%) — mid-range, not off the dip`);
  if (s.movePct > MAX_MOVE_PCT) r.push(`already +${s.movePct}% over the run (max ${MAX_MOVE_PCT}%) — spiked`);
  if (s.extPct > MAX_EXT_PCT) r.push(`${s.extPct}% above the 1h average (max ${MAX_EXT_PCT}%) — stretched`);
  if (s.candleX > MAX_CANDLE_X) r.push(`blow-off candle ${s.candleX}x normal range (max ${MAX_CANDLE_X}x)`);
  return r;
}

// Returns [] or one alert block per side that fired. Marks cooldown keys
// xrp_mom_buy / xrp_mom_sell on the shared cooldowns object.
export function collectXrpMomentumAlerts(entries, cooldowns, positions = {}) {
  if (!XRP_MOM_ENABLED) return [];
  const entry = entries.find(([pair]) => pair === XRP_MOM_PAIR)?.[1];
  const s = entry?.xrpStreak;
  if (!entry || entry.marketClosed || !s) return [];

  const price = entry.price;
  const holding = Object.values(positions).some(p => p?.base === 'XRP' && p?.status !== 'closed');
  const out = [];

  const sides = [
    { side: 'buy',  n: s.rising,
      ok: s.rising >= STREAK_MIN && s.movePct >= MIN_MOVE_PCT && price >= s.lastClose && (!REQUIRE_HL_LH || s.higherLows) },
    { side: 'sell', n: s.falling,
      ok: SELL_ENABLED && s.falling >= STREAK_MIN && s.movePct <= -MIN_MOVE_PCT && price <= s.lastClose && (!REQUIRE_HL_LH || s.lowerHighs) },
  ];

  for (const { side, n, ok } of sides) {
    if (!ok) continue;
    if (side === 'buy') {
      const knife = xrpKnifeReasons(s);
      if (knife.length) { console.log(`  🔪  XRP buy alert blocked (falling knife): ${knife.join(' · ')}`); continue; }
      const chase = xrpChaseReasons(s);
      if (chase.length) { console.log(`  🏃  XRP buy alert blocked (chasing a spike): ${chase.join(' · ')}`); continue; }
    }
    const key = `xrp_mom_${side}`;
    const last = cooldowns[key];                                      // { ts, streakStartTs }
    if (last?.streakStartTs === s.streakStartTs) continue;            // this streak already alerted
    if (last?.ts && (Date.now() - last.ts) < COOLDOWN_MIN * 60000) continue;

    const buy = side === 'buy';
    out.push([
      buy ? `🟢 *XRP BUY ALERT* — $${price}` : `🔴 *XRP SELL ALERT* — $${price}`,
      `  ${n} consecutive ${buy ? 'higher' : 'lower'} 5m closes · ${s.movePct > 0 ? '+' : ''}${s.movePct}% over the run · ${buy ? 'higher lows' : 'lower highs'} · price still ${buy ? 'above' : 'below'} last close ${s.lastClose}`,
      `  2h range ${s.rangeLow}–${s.high2h} · ${s.pullbackPct}% below 2h high${buy && s.dropPct >= MIN_DROP_PCT ? ` · ${s.recoveryPct}% of the ${s.dropPct}% drop recovered · run began ${s.baseOffLowPct}% off the low` : ''} · 0 fee on XRP`,
      !buy && holding ? `  You hold XRP — consider exiting (alert only, bot did not sell)` : null,
    ].filter(Boolean).join('\n'));
    cooldowns[key] = { ts: Date.now(), streakStartTs: s.streakStartTs };
  }
  return out;
}
