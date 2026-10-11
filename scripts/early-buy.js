// ═════════════════════════════════════════════════════════════════
// early-buy.js — "EARLY BUY" (P0 pre-spike accumulation) detector, ALERT-ONLY
//
// Goal: flag coins BEFORE the 5m/15m Supertrend cross buys them (the cross confirms after the
// impulse, which is where most recent entries were stopped out). Every clause must pass; a coin
// that fails exactly one clause is logged as a near-miss so the audit log shows which clause binds.
//
// Differences from the written spec, on purpose:
//  * "Before ST fires" is tested on the LIVE 5m Supertrend (still BEAR and within EARLY_APPROACH_ATR
//    below the line, or a BULL retest of it), not on the status of the last ST event - that status
//    is history (SKIPPED_GATE / EXPIRED mean a cross already happened and was rejected or went stale).
//  * Signal safety also excludes AVOID (worse than WEAK / FALLING KNIFE).
//  * Not-overheated clause (15m RSI below EARLY_MAX_RSI15) so "early" cannot mean "already ran".
//  * Shock threshold is > 1.0x (EARLY_SHOCK_MIN), per the request; was 1.20x.
// Field names are the real market-data.json ones (entry.bullConf, entry.d.shock, entry.d.cvdTrend...).
// Never executes a buy. Shadow results are scored with scripts/missed_signal_check.py.
// ═════════════════════════════════════════════════════════════════
const num = (n, d) => parseFloat(process.env[n] ?? d);

export const EARLY_MODE        = (process.env.EARLY_BUY_MODE || 'alert').toLowerCase();   // off | alert
export const EARLY_COOLDOWN_MIN = num('EARLY_COOLDOWN_MIN', '60');
const SHOCK_MIN   = num('EARLY_SHOCK_MIN', '1.0');
const BULL_MIN    = num('EARLY_BULLCONF_MIN', '3');
const BULL_MAX    = num('EARLY_BULLCONF_MAX', '7');
const WHALE_MIN   = num('EARLY_WHALE_MIN', '60');
const MAX_PENALTY = num('EARLY_MAX_BUYINTEL_PENALTY', '1');   // buyIntelPenalty 0 = clean, 1 = "-1"
const MAX_RSI15   = num('EARLY_MAX_RSI15', '68');
const APPROACH    = num('EARLY_APPROACH_ATR', '1.5');
const REQUIRE_OI  = (process.env.EARLY_REQUIRE_OI_CONFIRM ?? 'true') !== 'false';
const LOG_MAX_FAILED = num('EARLY_LOG_MAX_FAILED', '2');   // audit-log strict passes and coins failing at most this many clauses
const BAD_SIGNAL  = ['falling knife', 'weak', 'avoid'];

export function evaluateEarlyBuy(entry) {
  const d   = entry?.d || {};
  const st5 = entry?.supertrend5m || d.supertrend5m || null;
  const sig = String(entry?.signal || '').toLowerCase();
  const dist = st5?.distanceATR;
  const dir  = String(st5?.direction || '').toUpperCase();

  const approach = dir === 'BEAR' && dist != null && dist < 0 && dist >= -APPROACH;
  const retest   = dir === 'BULL' && st5?.retest === true && dist != null && dist <= APPROACH;
  const stage    = approach ? 'approach' : retest ? 'retest' : null;

  const trig = String(entry?.triggerStatus || '').toUpperCase();
  const clauses = {
    bullConf:     entry?.bullConf != null && entry.bullConf >= BULL_MIN && entry.bullConf <= BULL_MAX,
    shock:        parseFloat(d.shock) > SHOCK_MIN,
    cvdUp:        String(d.cvdTrend || '').toLowerCase() === 'up',
    oiConfirm:    !REQUIRE_OI || String(d.oiDiv || '').toUpperCase() === 'CONFIRM',
    buyIntel:     (entry?.buyIntelPenalty ?? 0) <= MAX_PENALTY,
    whale:        (entry?.whale?.score ?? 0) >= WHALE_MIN,
    signalSafe:   !BAD_SIGNAL.some(w => sig.includes(w)),
    trigger:      trig === 'TRIGGERING' || trig === 'BREAKOUT' || String(entry?.entryState || '').toUpperCase() === 'RETEST',
    preCross:     stage !== null,
    notOverheated: d.r15 == null || d.r15 < MAX_RSI15,
  };
  const failed = Object.keys(clauses).filter(k => !clauses[k]);
  return {
    pass: failed.length === 0, failed, clauses, stage,
    snap: {
      price: entry?.price ?? null, conv: entry?.conv ?? null, bullConf: entry?.bullConf ?? null,
      shock: d.shock ?? null, cvd: d.cvdTrend ?? null, oiDiv: d.oiDiv ?? null, whale: entry?.whale?.score ?? null,
      buyIntelPenalty: entry?.buyIntelPenalty ?? null, r15: d.r15 ?? null, signal: entry?.signal ?? null,
      trigger: entry?.triggerStatus ?? null, entryState: entry?.entryState ?? null,
      st5Dir: st5?.direction ?? null, st5DistATR: dist ?? null, chg24: entry?.chg ?? null,
    },
  };
}

// Builds alert lines for coins that pass every clause; logs strict passes and single-clause near-misses
// (60 min per symbol) to the audit log. Marks its own cooldown keys. Does NOT send - the caller does.
export function collectEarlyBuyAlerts({ entries, cooldowns, positions = {}, logAudit = () => {}, now = Date.now() }) {
  if (EARLY_MODE === 'off') return [];
  const heldBases = new Set(Object.keys(positions).map(k => String(k).replace(/^.*:/, '').toUpperCase()));
  const lines = [];
  for (const [pair, entry] of entries) {
    if (entry.assetType !== 'crypto' || entry.marketClosed) continue;
    const r = evaluateEarlyBuy(entry);
    if (r.pass || r.failed.length <= LOG_MAX_FAILED) {
      const lk = `lb_early_log_${pair}`;
      if (now - (cooldowns[lk] || 0) >= 60 * 60000) {
        logAudit('early_buy_candidate', { pair, priority: 'P0', type: 'EARLY_BUY', strict: r.pass, failed: r.failed, stage: r.stage, ...r.snap });
        cooldowns[lk] = now;
      }
    }
    if (!r.pass) continue;
    if (heldBases.has(String(pair).toUpperCase())) continue;
    const ck = `lb_early_${pair}`;
    if (now - (cooldowns[ck] || 0) < EARLY_COOLDOWN_MIN * 60000) continue;
    const s = r.snap, base = String(pair).replace(/^BINANCE:/, '').replace(/USDT$/, '');
    lines.push([
      `🟡 *${base}* — $${s.price}  \`P0\` · \`EARLY_BUY\`  [${r.stage}: ST5 ${s.st5Dir} ${s.st5DistATR} ATR]`,
      `  BullConf ${s.bullConf}/10 · shock ${s.shock}x · CVD ${s.cvd} · OI ${s.oiDiv} · whale ${s.whale} · RSI15 ${s.r15}`,
      `  Signal ${s.signal} · trigger ${s.trigger} · conv ${s.conv} · buy-intel penalty ${s.buyIntelPenalty}`,
    ].join('\n'));
    cooldowns[ck] = now;
  }
  return lines;
}
