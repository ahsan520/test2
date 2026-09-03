// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-decider.js — Job B (runs every 15 min)
// v11.0 — split build
//
// This file is the ORCHESTRATOR: it loads state, runs the buy-signal scan and
// recommendation ranking (below), and delegates everything else to its sibling
// modules:
//   position-monitor.js   — stop/T1/T2 detection, exit scoring, stale eviction
//   mexc-trader.js         — A/A+ rotation + star-pick auto-buy execution
//   telegram-commands.js   — sendTelegram() + /pause /resume polling
//   job-state.js            — shared I/O, paths, env constants, audit log
//
// KEY CHANGE from v10.9 (unchanged from the monolith): monitorPositions() runs
// every Job B cycle BEFORE the buy signal scan, so positions.json stays
// current even when the browser is never opened.
// ══════════════════════════════════════════════════════════════════════════════

import { calcConviction, getSetupMode } from './leaderboard-scanner.js';
import { buildSymKey, cooldownKey } from './exchange-registry.js';

import {
  logAudit, pushPositionsToGitHub, SKIP_SETUPS, TERMINAL_EVICT_MS,
  TRADE_MODE, TRADE_USD_SIZE, TRADE_MAX_LIVE,
  DRY_RUN, TG_ENABLED,
  MEXC_API_KEY, MEXC_API_SECRET,
  loadMarketData, saveMarketData, loadMarketState,
  loadPositions, savePositions,
  loadAlertState, saveAlertState,
  loadCooldowns, saveCooldowns,
  loadHistory, saveHistory,
  loadTradeState, saveTradeState,
  saveTradeLog, pushTradeLogToGitHub,
  loadAuditLog, pushAuditLogToGitHub, pushLiveBalancesToGitHub,
  checkHeartbeatStale, pushHeartbeatToGitHub,
} from './job-state.js';
import { mexcGetAllBalances } from './mexc-client.js';

import { sendTelegram, pollTelegramCommands } from './telegram-commands.js';
import { monitorPositions, reconcileTrackedLiveBalances } from './position-monitor.js';
import { executeTradeCycle, adoptManualHoldings, executeSTPriorityRotation, executeST5PriorityRotation } from './mexc-trader.js';
import { runAllBuyGuards, isDivergingFromBtc, checkBtcAlphaException, calcRelativeStrength, checkBull4hPersistence, checkMarketIntelligenceGate } from './market-guard.js';
import { checkEntryQuality } from './entry-quality-check.js';
import { evaluateSTTiming } from './st-timing-engine.js';

// ── Scout entry (reduced-size buy at TRIGGERING, before full BREAKOUT
// confirmation) — see the trigger-gate block below for the full rationale.
// Off by default; each threshold is independently overridable via repo
// Variables so this can be tuned/disabled without a code change.
const BUY_SCOUT_ENABLE       = (process.env.BUY_SCOUT_ENABLE || 'false') === 'true';
const BUY_SCOUT_SIZE_PCT     = parseFloat(process.env.BUY_SCOUT_SIZE_PCT || '30'); // % of normal per-pick size
const BUY_SCOUT_MIN_BULLCONF = parseFloat(process.env.BUY_SCOUT_MIN_BULLCONF || '7'); // stricter than normal EARLY BUY bar — earlier entry, so demand more structural confirmation elsewhere
const BUY_SCOUT_MIN_WHALE    = parseFloat(process.env.BUY_SCOUT_MIN_WHALE    || '60');

// Extra structural bar for a scout entry, on top of everything already
// required to reach this point in the candidate loop (LB_MIN_SCORE, 4H
// persistence, Market Intelligence gate, entryOkForBuy's CHASING/HIGH
// SHOCK exclusion via the caller). A scout buy is inherently less
// confirmed than a normal BUY (one of volume/CVD/BTC is still missing at
// TRIGGERING) — this asks for stronger whale/bullConf backing to
// compensate, same logic as buy-intelligence.js's own quality floor.
function entryOkForScout(entry) {
  return (entry.bullConf || 0) >= BUY_SCOUT_MIN_BULLCONF && (entry.whale?.score || 0) >= BUY_SCOUT_MIN_WHALE;
}

const LB_MIN_SCORE       = parseInt(process.env.LB_MIN_SCORE       || '9');
const LB_BULL_CONF_MIN   = parseInt(process.env.LB_BULL_CONF_MIN   || '5');
const LB_COOLDOWN_MIN    = parseInt(process.env.LB_COOLDOWN_MIN    || '60');
const LB_HOLD_LOCK       = parseInt(process.env.LB_HOLD_LOCK       || '20');
const ALLOW_PRE_MARKET   = (process.env.LB_ALLOW_PRE_MARKET || 'false') === 'true';
const ALLOW_AH           = (process.env.LB_ALLOW_AH         || 'false') === 'true';
const ALERT_STATE_TTL    = parseFloat(process.env.LB_ALERT_STATE_TTL_HOURS || '6');

// ── Bad-history buy gate ─────────────────────────────────────────────────
// A symbol with a long, consistent losing streak (e.g. AVAX bought twice in
// one day, both closed via thesis-invalidated within 90 min; GALA at 0W-17L)
// is one of the strongest signals this system produces — but until now
// histWinRate/histSample were informational-only (shown in the Telegram
// alert's "past 30d" line) and had zero effect on whether the buy actually
// happened. Two tiers, both requiring a real sample size so a symbol with
// only 2-3 closes never gets unfairly flagged:
//   HARD: sample ≥10 AND winRate ≤10%  → skip entirely, no candidate created
//   SOFT: sample ≥6  AND winRate ≤20%  → heavy conv penalty (very likely
//         drops it below LB_MIN_SCORE on its own, without a hard block)
const HIST_GATE_HARD_MIN_SAMPLE = parseInt(process.env.BUY_HIST_GATE_HARD_MIN_SAMPLE || '10');
const HIST_GATE_HARD_MAX_WINRATE = parseFloat(process.env.BUY_HIST_GATE_HARD_MAX_WINRATE || '0.10');
const HIST_GATE_SOFT_MIN_SAMPLE = parseInt(process.env.BUY_HIST_GATE_SOFT_MIN_SAMPLE || '6');
const HIST_GATE_SOFT_MAX_WINRATE = parseFloat(process.env.BUY_HIST_GATE_SOFT_MAX_WINRATE || '0.20');
const HIST_GATE_SOFT_PENALTY = parseInt(process.env.BUY_HIST_GATE_SOFT_PENALTY || '4');
const HIST_GATE_LOOKBACK_DAYS = parseFloat(process.env.BUY_HIST_GATE_LOOKBACK_DAYS || process.env.RECO_LOOKBACK_DAYS || '30');

// ── Same-day repeat-failure pause ──────────────────────────────────────
// The 30-day bad-history gate above needs 6-10 closes to arm — no help
// against a symbol failing repeatedly TODAY (e.g. AVAX: 3 losses in one
// day, each 30-90 min buy-to-close, thesis-invalidated each time). A
// single loss should NOT pause a symbol — crypto alts mostly track BTC,
// so one stop-out followed by a real BTC bounce dragging the alt back up
// is a completely legitimate reason to re-buy quickly, and blocking that
// would cost real opportunities for no good reason. This only pauses on a
// genuine repeated pattern: 2+ LOSSES on the same symbol within a short
// recent window — a much stronger "this isn't working today" signal than
// any single stop-out, and short enough (a few hours) to not overlap with
// the 30-day gate's job.
const SAMEDAY_FAIL_ENABLED     = (process.env.BUY_SAMEDAY_FAIL_ENABLE || 'true') !== 'false';
const SAMEDAY_FAIL_COUNT       = parseInt(process.env.BUY_SAMEDAY_FAIL_COUNT || '2', 10);
const SAMEDAY_FAIL_WINDOW_HRS  = parseFloat(process.env.BUY_SAMEDAY_FAIL_WINDOW_HRS || '4');
const SAMEDAY_FAIL_PAUSE_HRS   = parseFloat(process.env.BUY_SAMEDAY_FAIL_PAUSE_HRS  || '3');

// Only used for the startup banner/audit log — the actual gating logic for
// these lives in position-monitor.js.
const LB_STALE_WATCH_HRS = parseFloat(process.env.LB_STALE_WATCH_HRS || '24');
const LB_EXIT_CVD_CYCLES = parseInt(process.env.LB_EXIT_CVD_CYCLES || '3');
const LB_EXIT_SCORE_MIN  = parseInt(process.env.LB_EXIT_SCORE_MIN  || '3');

// ── Multi-signal recommendation (top N by past spike history) ──
const RECO_MIN_SIGNALS   = parseInt(process.env.LB_RECO_MIN_SIGNALS    || '3');   // only annotate when this many+ fire in one cycle
const RECO_TOP_N         = parseInt(process.env.LB_RECO_TOP_N          || '3');   // how many to star as recommended
const RECO_LOOKBACK_DAYS = parseFloat(process.env.LB_RECO_LOOKBACK_DAYS|| '30');  // history window used for win-rate
const HISTORY_RETENTION_DAYS = parseFloat(process.env.LB_HISTORY_RETENTION_DAYS || '45'); // how long symbol-history.json keeps rows
const HISTORY_MAX_ROWS    = parseInt(process.env.LB_HISTORY_MAX_ROWS || '1500'); // hard cap regardless of days — safety net vs. size blowup

// ── Cooldown helpers ──
function isOnCooldown(state, cdKey, assetType) {
  const ts = state[cdKey] || 0;
  if (assetType === 'crypto') return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
  return ts > 0; // stocks: date-keyed, any truthy = fired today
}
function markCooldown(state, cdKey) { state[cdKey] = Date.now(); }

// ── MOM WATCH — separate, lower-bar heads-up tier (2026-09-03 redesign) ──
// Fires independently of LB_MIN_SCORE — the whole point is to surface a
// genuine 5m momentum burst (calcSpikeTrigger's momentumBurstActive,
// buy-intelligence.js) even on a cycle where NOTHING clears the real buy
// bar, which is exactly the XRP/BTC 2026-09-03 case: price kept climbing on
// 5m closes with BTC also up, but conv (whale/CVD-driven) hadn't caught up
// yet. Purely informational — never feeds execution, never auto-buys, never
// bypasses LB_MIN_SCORE for the real buy path below.
const MOM_WATCH_ENABLED          = (process.env.LB_MOM_WATCH_ENABLE ?? 'true') !== 'false';
const LB_MOM_MIN_SCORE           = parseInt(process.env.LB_MOM_MIN_SCORE           || '0', 10);  // floor to skip clearly-broken setups — far below LB_MIN_SCORE by design
const LB_MOM_WATCH_COOLDOWN_MIN  = parseInt(process.env.LB_MOM_WATCH_COOLDOWN_MIN  || '20', 10); // shorter than LB_COOLDOWN_MIN — fast informational tier

// Builds MOM WATCH alert lines and marks each hit's own cooldown key
// (`lb_mom_<pair>`, independent of the buy-alert cooldown). Does NOT send —
// caller composes the final Telegram message and calls sendTelegram, same
// pattern as every other alert block in main().
function collectMomWatchAlerts(entries, cooldowns) {
  if (!MOM_WATCH_ENABLED) return [];
  const lines = [];
  for (const [pair, entry] of entries) {
    if (entry.assetType !== 'crypto' || entry.marketClosed) continue;
    if (!entry.trigger?.momentumBurstActive) continue;
    if ((entry.conv ?? -Infinity) < LB_MOM_MIN_SCORE) continue;
    if (entry.signal === 'FALLING KNIFE') continue; // safety floor

    const momKey = `lb_mom_${pair}`;
    const ts = cooldowns[momKey] || 0;
    if ((Date.now() - ts) < LB_MOM_WATCH_COOLDOWN_MIN * 60000) continue;

    const st5 = entry.d?.supertrend5m || entry.supertrend5m;
    lines.push([
      `⚡ *${pair.replace('USDT', '')}* — $${entry.price}  [conv ${entry.conv}, bullConf ${entry.bullConf}/10]`,
      `  ${entry.trigger.risingStreak} consecutive rising 5m closes · CVD ${entry.d?.cvdTrend ?? 'n/a'} · ST5 ${st5?.direction ?? 'n/a'}/${st5?.extensionZone ?? 'n/a'} · whale ${entry.whale?.score ?? '—'}/100 ${entry.whale?.zone ?? ''}`,
      `  Below buy bar (conv ${entry.conv} < ${LB_MIN_SCORE}) — watch, not a buy signal`,
    ].join('\n'));
    cooldowns[momKey] = Date.now();
  }
  return lines;
}

// Dedicated post-stop-loss cooldown — see the STEP 1 comment where it's
// set. Deliberately independent of LB_COOLDOWN_MIN (and typically longer)
// so it isn't just re-deriving the same window a stop-out already lives
// inside of.
const STOP_COOLDOWN_MIN = parseInt(process.env.LB_STOP_COOLDOWN_MIN || '90', 10);
function isOnStopCooldown(state, pair) {
  const ts = state[`lb_stopcd_${pair}`] || 0;
  return (Date.now() - ts) < STOP_COOLDOWN_MIN * 60000;
}

// ── Same-day repeat-failure check ──────────────────────────────────────
// See the constants block above for the reasoning. Deliberately looks at
// LOSSES ONLY (pnlPct <= 0) — a symbol that closed profitably twice today
// obviously shouldn't get paused, and mixing wins/losses into one count
// would blur the exact signal this is meant to catch.
function checkSamedayFailures(history, base) {
  if (!SAMEDAY_FAIL_ENABLED) return { paused: false, reason: null, count: 0 };
  const windowCutoff = Date.now() - SAMEDAY_FAIL_WINDOW_HRS * 3_600_000;
  const recentLosses = history.filter(e =>
    e.base === base && e.closedAt >= windowCutoff && (e.pnlPct ?? 0) <= 0
  );
  if (recentLosses.length < SAMEDAY_FAIL_COUNT) return { paused: false, reason: null, count: recentLosses.length };

  // Pause window runs from the MOST RECENT of those losses, not the
  // oldest — so the pause resets forward if it keeps failing, rather than
  // expiring based on a stale first loss from hours ago.
  const mostRecentLossAt = Math.max(...recentLosses.map(e => e.closedAt));
  const pauseUntil = mostRecentLossAt + SAMEDAY_FAIL_PAUSE_HRS * 3_600_000;
  if (Date.now() >= pauseUntil) return { paused: false, reason: null, count: recentLosses.length };

  const minsLeft = Math.round((pauseUntil - Date.now()) / 60000);
  return {
    paused: true,
    count: recentLosses.length,
    reason: `${recentLosses.length} losses in the last ${SAMEDAY_FAIL_WINDOW_HRS}h — paused ${minsLeft} more min`,
  };
}

function pruneAlertState(state) {
  const cutoff = Date.now() - ALERT_STATE_TTL * 3_600_000;
  for (const [sym, e] of Object.entries(state)) {
    if ((e.lastSeenAt || 0) < cutoff) delete state[sym];
  }
  return state;
}

function calcEntryLevels(price, shock) {
  const p = parseFloat(price) || 0;
  if (!p) return null;
  const atr   = p * 0.015 * Math.max(1, shock * 0.5);
  const dp    = p < 10 ? 4 : 2;
  // Entry = current price, no chase markup. Every buy is a MEXC MARKET
  // order (fills near-instantly at whatever price is live) — the old
  // +0.4% markup never changed what got paid, it just inflated the
  // reference entry used to anchor stop/rr math, widening effective
  // risk-per-trade beyond what STOP_LOSS_PCT implied. mexc-trader.js
  // resyncs entryPrice/stop/t1/t2 to the REAL fill price after the order
  // executes (see recalcLevelsFromFill in mexc-trader.js) — this pre-fill
  // estimate is only what the buy alert / rank / caution tags see.
  const entry = p.toFixed(dp);
  // Fixed-percentage stop — deliberately NOT volatility-scaled.
  // Previously (ATR_STOP_MULT) the stop widened automatically on
  // high-shock days, which defeats the purpose of setting a small,
  // predictable max-loss-per-trade: since crypto is close to always
  // volatile, the "floor" behavior rarely applied in practice, and
  // several trades realized 1-2%+ losses despite ATR_STOP_MULT being
  // set to a value implying ~0.1-0.15%. STOP_LOSS_PCT is now a hard,
  // fixed % of entry price, every time, regardless of shock/volatility.
  const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.1');
  const stop  = (p * (1 - STOP_LOSS_PCT / 100)).toFixed(dp);
  const t1    = (p + atr * 2).toFixed(dp);
  const t2    = (p + atr * 4).toFixed(dp);
  const rr    = (parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop));
  return { entry, stop, t1, t2, rr: isFinite(rr) ? rr.toFixed(1) : '—' };
}

// ══════════════════════════════════════════════════════════════════════════════
// Historical spike-strength ranking — used to recommend top N when several
// buy signals fire in the same cycle. Purely informational (Telegram-only,
// no gating of which positions actually open).
// ══════════════════════════════════════════════════════════════════════════════
function getHistoryStrength(history, base, lookbackDays) {
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const rows = history.filter(e => e.base === base && e.closedAt >= cutoff);
  if (!rows.length) return { winRate: null, sample: 0, avgPnl: null, strength: 0 };

  // A "win" is a profitable close, not a specific exit reason — the
  // original `outcome === 'tp2_hit'` definition meant T1 partials,
  // Profit Protection exits, rotation-freed slots, and any
  // Position-Intelligence exit that still closed in the green all got
  // counted as losses, even though the trade made money. With T1/Profit
  // Protection/rotation all designed to close BEFORE T2 by intent, T2 is
  // typically the least common way a good trade actually ends — so the
  // old definition was silently near-zeroing out win rate for every
  // symbol regardless of real performance. pnlPct > 0 reflects what
  // actually happened to the money.
  const wins    = rows.filter(e => (e.pnlPct || 0) > 0).length;
  const winRate = wins / rows.length;
  const avgPnl  = rows.reduce((s, e) => s + (e.pnlPct || 0), 0) / rows.length;

  // Confidence-weighted: winRate dampened when sample size is thin (<5),
  // plus a small nudge for average P&L so a 100%-but-tiny sample doesn't
  // automatically beat a well-proven symbol.
  const confidence = Math.min(1, rows.length / 5);
  const strength   = winRate * confidence + Math.max(0, avgPnl) * 0.01;

  return { winRate, sample: rows.length, avgPnl, strength };
}

// ── peak/latest evaluator ──
function evaluateSymbol(entry) {
  const latest    = { conv: entry.conv, setup: entry.setup, shock: entry.d?.shock, obi: entry.d?.obi };
  const peakD     = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
  const peakConv  = calcConviction(peakD);
  const peakSetup = getSetupMode({ ...peakD, conv: peakConv });
  return peakConv > latest.conv && !SKIP_SETUPS.has(peakSetup.label)
    ? { conv: peakConv, setup: peakSetup, source: 'peak', shock: entry.peakShock, obi: entry.peakObi }
    : { ...latest, source: 'latest' };
}

function resetPeaks(market) {
  const now = Date.now();
  for (const entry of Object.values(market.symbols || {})) {
    entry.peakShock = entry.d?.shock ?? entry.peakShock;
    entry.peakObi   = entry.d?.obi   ?? entry.peakObi;
    entry.peakSince = now;
  }
  return market;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Leaderboard Decider v11.0 — ${new Date().toUTCString()}`);
  console.log(`MinScore:${LB_MIN_SCORE} BullConf:${LB_BULL_CONF_MIN} Cooldown:${LB_COOLDOWN_MIN}min StaleHrs:${LB_STALE_WATCH_HRS} DryRun:${DRY_RUN}`);
  console.log('═'.repeat(60));

  logAudit('job_start', {
    minScore: LB_MIN_SCORE, bullConfMin: LB_BULL_CONF_MIN,
    cooldownMin: LB_COOLDOWN_MIN, staleWatchHrs: LB_STALE_WATCH_HRS,
    exitCvdCycles: LB_EXIT_CVD_CYCLES, exitScoreMin: LB_EXIT_SCORE_MIN,
    allowAH: ALLOW_AH, allowPre: ALLOW_PRE_MARKET,
    ghRepo: process.env.GH_REPO || '✗ missing',
    tgEnabled: TG_ENABLED, dryRun: DRY_RUN,
  });

  // ── Heartbeat staleness check ──
  // The schedule expects this job every ~17 min (alerts.yml: minutes
  // 2,19,36,53). GitHub Actions can silently delay or skip scheduled runs
  // with no notification — this is how the bot notices a gap itself rather
  // than someone finding out retroactively. Threshold is 2.5x the expected
  // interval so normal jitter (a run taking a bit longer, GitHub's usual
  // few-minutes cron slop) doesn't false-alarm.
  const heartbeat = checkHeartbeatStale(17, 2.5);
  if (heartbeat.stale) {
    console.log(`  ⚠️  STALE RUN — last successful run was ${heartbeat.gapMinutes} min ago (expected ~17min)`);
    logAudit('heartbeat_stale', { gapMinutes: heartbeat.gapMinutes, lastRunAt: heartbeat.lastRunAt });
    await sendTelegram(
      `⚠️ *STALE RUN DETECTED*\n` +
      `  Last successful run was ${heartbeat.gapMinutes.toFixed(0)} minutes ago (expected ~every 17 min).\n` +
      `  _Check GitHub Actions run history for failed/skipped scheduled runs — positions.json and reconciliation may be out of date until this resolves._`
    );
  }

  const market      = loadMarketData();
  const marketState = loadMarketState(); // v15 Market Intelligence Engine output — read-only here
  const entries = Object.entries(market.symbols || {});

  if (!entries.length) {
    console.log('[leaderboard-decider] market-data.json empty — has market-fetcher run yet?');
    logAudit('market_data_empty');
    return;
  }

  const ageMin = (Date.now() - (market.fetchedAt || 0)) / 60000;
  const STALE_THRESHOLD_MIN = market.staleAfterMinutes || 30;
  const dataIsStale = ageMin > STALE_THRESHOLD_MIN;
  if (dataIsStale) {
    console.log(`[leaderboard-decider] ⚠ market-data.json is ${ageMin.toFixed(1)} min old — blocking new buys this cycle`);
    logAudit('market_data_stale', { ageMin: parseFloat(ageMin.toFixed(1)), thresholdMin: STALE_THRESHOLD_MIN });
    await sendTelegram(
      `🚨 *STALE MARKET DATA* — ${ageMin.toFixed(0)} min old (threshold ${STALE_THRESHOLD_MIN} min)\n` +
      `  New buy signals are BLOCKED this cycle — won't open a position off outdated prices.\n` +
      `  _Open positions are still monitored for stop/target using this same data — verify current prices manually on MEXC if you're relying on exit timing right now._`
    );
  }

  const cryptoCount = entries.filter(([, e]) => e.assetType === 'crypto').length;
  const stockCount  = entries.filter(([, e]) => e.assetType === 'stock').length;
  const frozenCount = entries.filter(([, e]) => e.marketClosed).length;
  console.log(`[leaderboard-decider] ${entries.length} symbols — ${cryptoCount} crypto, ${stockCount} stock (${frozenCount} frozen)`);

  // ══════════════════════════════════════════════════════
  // STEP 1 — Monitor open positions (exit/stop/stale)
  // Runs BEFORE buy scan so freed slots are available.
  // ══════════════════════════════════════════════════════
  let positions = loadPositions();

  // GUI toggle writes `tradeMode`/`execStrategy`/etc to trade-state.json —
  // these take precedence when set, so the browser control still works
  // without a repo-variable change. BUT trade-state.json itself only ever
  // gets written when someone actually uses the GUI toggle — if it's never
  // touched (or gets reset/cleared), these fall back to repo Variables
  // below rather than a silently different hardcoded default. This means a
  // browser cache clear no longer risks reverting live trading behavior to
  // an unexpected default — the repo Variable is the durable source of
  // truth, and the GUI is an optional session-level override on top of it.
  let tradeState = loadTradeState();
  tradeState = await pollTelegramCommands(tradeState);
  saveTradeState(tradeState);

  const effectiveTradeMode     = tradeState.tradeMode     || TRADE_MODE;
  // EXEC_STRATEGY: 'top1' | 'topN'. Repo Variable, defaults to 'top1' if unset.
  const effectiveExecStrategy  = tradeState.execStrategy  || process.env.EXEC_STRATEGY || 'top1';
  // EXEC_TOP_N_COUNT: how many starred picks 'topN' actually buys (e.g. 2 or
  // 3), rather than every currently-starred symbol. Repo Variable; unset/0
  // keeps the original behavior of buying ALL starred picks (uncapped).
  const effectiveTopNCount     = tradeState.execTopNCount || parseInt(process.env.EXEC_TOP_N_COUNT || '0', 10) || null;
  const effectiveUsdSize       = tradeState.usdSize       || TRADE_USD_SIZE;
  const effectiveMaxLive       = tradeState.maxLive       || TRADE_MAX_LIVE;
  // TRADE_SIZE_MODE: 'usd' (fixed dollar, default) | 'percent' (% of balance,
  // compounds — see mexc-trader.js executeAutoBuys for the balance lookup).
  const effectiveSizeMode      = tradeState.sizeMode      || process.env.TRADE_SIZE_MODE || 'usd';
  const effectiveSizePct       = tradeState.sizePct       || parseFloat(process.env.TRADE_SIZE_PCT || '100');

  // Sizing per pick is NOT a separate variable — it's a fixed rule, always:
  //   top1 → 100% of effectiveUsdSize on the single pick
  //   topN → effectiveUsdSize split EQUALLY across however many picks are
  //          actually bought (capped at effectiveTopNCount if set)
  // See mexc-trader.js's perPickUsd calculation — no config needed for this.

  // ── Fresh start on off/paper → live transition ──
  // Paper (and off) mode can leave behind positions.json entries and
  // trade-log.json rows that mean nothing once real money is involved (paper
  // fills, test qty values, etc.) — and they'd otherwise sit there confusing
  // the "API Trades" journal and occupying live-slot counts the moment you
  // flip to live. Detect the transition once (tracked in trade-state.json so
  // it only fires on the actual switch, not every cycle you stay in live)
  // and wipe both files so live trading always starts from a clean slate.
  // NOTE: this only clears the bot's own tracking — it never touches your
  // real MEXC wallet balance.
  const previousTradeMode = tradeState.lastTradeMode || TRADE_MODE;
  if (previousTradeMode !== 'live' && effectiveTradeMode === 'live') {
    console.log(`  🔄  TRADE MODE CHANGED: ${previousTradeMode} → live — resetting positions.json and trade-log.json`);
    positions = {};
    savePositions(positions);
    await pushPositionsToGitHub(positions);
    saveTradeLog([]);
    await pushTradeLogToGitHub([]);
    logAudit('trade_mode_reset', { from: previousTradeMode, to: 'live' });
    await sendTelegram(
      `🔄 *TRADE MODE → LIVE* — ${new Date().toUTCString().slice(17, 22)} UTC\n` +
      `  Switched from *${previousTradeMode}* to *live*.\n` +
      `  positions.json and the API Trades journal have been reset to start fresh.\n` +
      `  _Your real MEXC wallet balance is untouched — this only clears the bot's own tracking._`
    );
  }
  tradeState.lastTradeMode = effectiveTradeMode;
  saveTradeState(tradeState);
  const openCount = Object.keys(positions).length;

  if (openCount > 0) {
    console.log(`\n📊  Monitoring ${openCount} open position(s)...`);
    const monitored = await monitorPositions(positions, market.symbols || {}, {
      LB_MIN_SCORE, LB_BULL_CONF_MIN,
    }, marketState);
    positions = monitored.positions;

    if (monitored.changed) {
      savePositions(positions);
      await pushPositionsToGitHub(positions);
    }

    if (monitored.closedOutcomes.length) {
      let history = loadHistory();
      history.push(...monitored.closedOutcomes);
      const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
      history = history.filter(e => e.closedAt >= cutoff);
      if (history.length > HISTORY_MAX_ROWS) history = history.slice(history.length - HISTORY_MAX_ROWS);
      saveHistory(history);
      logAudit('history_recorded', { rows: monitored.closedOutcomes.length, totalKept: history.length });

      // ── Post-stop-loss cooldown ──────────────────────────────────────
      // Separate from the generic post-alert cooldown (LB_COOLDOWN_MIN,
      // checked below in STEP 2) and from the 2-loss same-day-failure
      // pause (checkSamedayFailures — deliberately requires 2+ losses so
      // one bad trade doesn't block a real re-qualifying signal). This one
      // exists for the specific "stopped out, then the exact same
      // breakout level gets re-reclaimed and re-alerts before the generic
      // 60-min cooldown expires" pattern — e.g. two UNI stop-outs 65 min
      // apart, both off the same breakout level, each losing ~1.7%. A
      // single stop-out on a symbol blocks a fresh buy alert on THAT
      // symbol for STOP_COOLDOWN_MIN, independent of the alert cooldown's
      // own timer. Saved immediately (own load/save) rather than piggy-
      // backing on the `cooldowns` var loaded in STEP 2 below, so it's
      // captured even on a cycle that exits early via a hard guard block.
      const freshStops = monitored.closedOutcomes.filter(o => o.outcome === 'stopped');
      if (freshStops.length) {
        const stopCooldowns = loadCooldowns();
        for (const o of freshStops) stopCooldowns[`lb_stopcd_${o.pair}`] = Date.now();
        saveCooldowns(stopCooldowns);
        logAudit('stop_cooldown_set', { symbols: freshStops.map(o => o.pair), minutes: STOP_COOLDOWN_MIN });
      }
    }

    // Send all exit/stop/stale Telegram alerts
    for (const msg of monitored.telegramAlerts) {
      await sendTelegram(msg);
    }

    if (monitored.changed) {
      logAudit('monitor_complete', {
        openBefore: openCount,
        openAfter:  Object.keys(positions).length,
        alerts:     monitored.telegramAlerts.length,
      });
    }
  }

  // ══════════════════════════════════════════════════════
  // STEP 1.5 — Adopt untracked MEXC holdings (manual buys)
  // Live only — paper mode has no real exchange balance to reconcile.
  // Must run BEFORE the buy scan below so its open-position gate sees any
  // newly-adopted symbol as already-tracked (no duplicate signal/buy).
  // ══════════════════════════════════════════════════════
  if (effectiveTradeMode === 'live') {
    const adopted = await adoptManualHoldings({ positions, market, evaluateSymbol, calcEntryLevels });
    positions = adopted.positions;
    if (adopted.changed) {
      savePositions(positions);
      await pushPositionsToGitHub(positions);
    }
  }

  // ══════════════════════════════════════════════════════
  // STEP 1.6 — Reconcile tracked live positions against REAL MEXC balance
  // Runs every live cycle, independent of whether rotation has a new pick
  // this cycle — otherwise a manually-sold position whose price never
  // crosses its own stop/target could sit "open" in positions.json
  // indefinitely, silently blocking that symbol from future alerts.
  // ══════════════════════════════════════════════════════
  if (effectiveTradeMode === 'live') {
    const reconcileUtc = new Date().toUTCString().slice(17, 22) + ' UTC';
    const reconciled = await reconcileTrackedLiveBalances(positions, effectiveTradeMode, reconcileUtc);
    if (reconciled.telegramAlerts.length) {
      for (const m of reconciled.telegramAlerts) await sendTelegram(m);
    }
    if (reconciled.changed) {
      savePositions(positions);
      await pushPositionsToGitHub(positions);
    }
  }

  // ══════════════════════════════════════════════════════
  // STEP 1.6 — 5m Supertrend Priority Execution (Priority-0 / P0)
  // Highest-priority buy path — see mexc-trader.js executeST5PriorityRotation
  // for the full rationale. Runs BEFORE the 15m/P1 pass just below, so a
  // symbol with both a fresh 5m and 15m cross pending in the same cycle
  // gets bought via P0 (this pass); P1 then sees the resulting position
  // and marks its own pending event NOOP_ALREADY_HELD rather than
  // double-buying. Same persistence/history pattern as the P1 block.
  // ══════════════════════════════════════════════════════
  const st5PriorityOutcomes = [];
  const st5Result = await executeST5PriorityRotation({
    market, positions, tradeState, effectiveTradeMode, effectiveMaxLive,
    effectiveSizeMode, effectiveSizePct,
    utc: new Date().toUTCString().slice(17, 22) + ' UTC',
    closedOutcomes: st5PriorityOutcomes,
    marketState,
  });
  saveMarketData(market);
  if (st5Result.changed) {
    savePositions(positions);
    await pushPositionsToGitHub(positions);
  }
  if (st5PriorityOutcomes.length) {
    let st5Hist = loadHistory();
    st5Hist.push(...st5PriorityOutcomes);
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
    st5Hist = st5Hist.filter(e => e.closedAt >= cutoff);
    if (st5Hist.length > HISTORY_MAX_ROWS) st5Hist = st5Hist.slice(st5Hist.length - HISTORY_MAX_ROWS);
    saveHistory(st5Hist);
    logAudit('history_recorded', { rows: st5PriorityOutcomes.length, totalKept: st5Hist.length, source: 'st5_priority' });
  }

  // ══════════════════════════════════════════════════════
  // STEP 1.7 — 15m Supertrend Priority Execution (Priority-1 / P1)
  // Per the "15m Supertrend Priority Execution" dev-team note: a confirmed
  // closed-15m Supertrend RED→GREEN cross (detected in market-fetcher.js,
  // persisted as a PENDING st15Event on the symbol's market-data.json
  // entry) rotates existing positions into the new candidate, bypassing
  // every STRATEGY gate below (grade, conv, whale, EQC, cooldown, Top-N,
  // etc.) — but not TRADE_MODE/kill-switch/credentials/no-trade-list/
  // duplicate-holding/balance/concurrency-cap, and never buys after an
  // unconfirmed sell. Runs independently of, and BEFORE, the buy scan —
  // an ST event can execute on a cycle where the normal scan (below) finds
  // nothing, and does not wait on the stale-market-data gate that blocks
  // new BUYs further down (this event is priced off the same market-data.json
  // this whole run already loaded, same as everything else this cycle).
  // Runs AFTER the P0/ST5 pass above — see that block's comment for why.
  // ══════════════════════════════════════════════════════
  const stPriorityOutcomes = [];
  const stResult = await executeSTPriorityRotation({
    market, positions, tradeState, effectiveTradeMode, effectiveMaxLive,
    effectiveSizeMode, effectiveSizePct,
    utc: new Date().toUTCString().slice(17, 22) + ' UTC',
    closedOutcomes: stPriorityOutcomes,
    marketState,
  });
  // Always persist — event status transitions (PENDING → EXECUTING →
  // EXECUTED/SELL_FAILED/BUY_FAILED/etc.) must survive even on an early
  // return further down (e.g. the stale-data guard just below), so the
  // same event is never re-attempted next cycle.
  saveMarketData(market);
  if (stResult.changed) {
    savePositions(positions);
    await pushPositionsToGitHub(positions);
  }
  if (stPriorityOutcomes.length) {
    let stHist = loadHistory();
    stHist.push(...stPriorityOutcomes);
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
    stHist = stHist.filter(e => e.closedAt >= cutoff);
    if (stHist.length > HISTORY_MAX_ROWS) stHist = stHist.slice(stHist.length - HISTORY_MAX_ROWS);
    saveHistory(stHist);
    logAudit('history_recorded', { rows: stPriorityOutcomes.length, totalKept: stHist.length, source: 'st15_priority' });
  }

  // Persist tradeState here — both the ST5 (STEP 1.6) and ST15 (STEP 1.7)
  // passes above may have set tradeState.lastSTRotationAt (dev-team note
  // "ST5 / ST15 Priority Buy & Multi-Alert Rotation" §4's rotation-storm
  // cooldown), and the last saveTradeState() call was earlier in this
  // function, before either pass ran.
  saveTradeState(tradeState);

  // ══════════════════════════════════════════════════════
  // STEP 2 — Scan for new BUY signals
  // Skipped entirely if market data is stale (see gate above) — no new
  // position should open off outdated prices. Monitoring/exits in STEP 1
  // already ran regardless, since leaving open positions unwatched during
  // a stale-data window is worse than evaluating exits with a flagged
  // caveat.
  // ══════════════════════════════════════════════════════
  if (dataIsStale) {
    console.log(`\n⏭  Buy scan skipped this cycle — market data too stale.`);
    logAudit('buy_scan_skipped_stale_data', { ageMin: parseFloat(ageMin.toFixed(1)) });
    logAudit('job_complete');
    await pushHeartbeatToGitHub(Date.now());
    await pushAuditLogToGitHub(loadAuditLog());
    console.log('\n✅  Job B complete (buy scan skipped — stale data).\n');
    return;
  }

  console.log(`\n🔍  Scanning for buy signals...`);

  // Loaded here (not further below, where it used to live) so MOM WATCH —
  // see below — has cooldown state available on the early no-candidate
  // return path too, not just the normal buy path.
  const cooldowns = loadCooldowns();

  // Pre-screen — bail early if nothing clears min score
  const anyCandidate = entries.some(([, entry]) => {
    if (entry.marketClosed) return false;
    if (entry.conv >= LB_MIN_SCORE && !SKIP_SETUPS.has(entry.setup?.label)) return true;
    const peakD    = { ...entry.d, shock: entry.peakShock, obi: entry.peakObi };
    const peakConv = calcConviction(peakD);
    return peakConv >= LB_MIN_SCORE && !SKIP_SETUPS.has(getSetupMode({ ...peakD, conv: peakConv }).label);
  });

  if (!anyCandidate) {
    const bestConv = Math.max(...entries.map(([, e]) => e.conv ?? -Infinity));
    console.log(`  Pre-screen: nothing reaches ${LB_MIN_SCORE} (best conv: ${bestConv}) — no buys this cycle.`);

    // MOM WATCH — this is exactly the 2026-09-03 XRP/BTC case: pre-screen
    // finds nothing at real buy-bar conviction, but a genuine 5m momentum
    // burst may still be underway. Fires here specifically so it's never
    // silently swallowed by this early return.
    const momLines = collectMomWatchAlerts(entries, cooldowns);
    if (momLines.length) {
      await sendTelegram([
        `⚡ *Alpha Terminal — MOM WATCH*`,
        `_informational only — not a buy signal, no execution triggered · min score ${LB_MIN_SCORE} not cleared this cycle_`,
        '', momLines.join('\n\n'),
      ].join('\n'));
      saveCooldowns(cooldowns);
    }

    logAudit('no_candidates', { bestConv, momWatchAlerts: momLines.length });
    saveMarketData(resetPeaks(market));
    logAudit('job_complete');
    await pushHeartbeatToGitHub(Date.now());
    console.log(`\n✅  Job B complete${momLines.length ? ` (${momLines.length} MOM WATCH heads-up sent)` : ''}.\n`);
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MARKET GUARD — 5-layer news-shock / dip protection
  // Runs AFTER monitoring (so fresh position P&L is available for circuit
  // breaker) and BEFORE opening any new positions.
  // ══════════════════════════════════════════════════════════════════════════
  const guard = runAllBuyGuards(market, positions, marketState);

  if (guard.reasons.length) {
    console.log('  🛡  Market guard fired:');
    guard.reasons.forEach(r => console.log(`     → ${r}`));
    logAudit('market_guard', { canBuy: guard.canBuy, closeAll: guard.closeAll, sizeMult: guard.sizeMult, reasons: guard.reasons });
  }

  // Layer 2 / BTC panic: close ALL live positions immediately
  if (guard.closeAll && effectiveTradeMode !== 'off') {
    const livePosEntries = Object.entries(positions).filter(
      ([, p]) => p.assetType === 'crypto'
              && p.liveOrder?.mode === effectiveTradeMode
              && !p.liveOrder?.closedAt
              && !['stopped', 'tp1_hit', 'tp2_hit', 'exiting'].includes(p.status)
    );

    if (livePosEntries.length) {
      console.log(`  🚨  Emergency close — ${livePosEntries.length} live position(s)`);
      const guardSells = [];
      let failedCount = 0;
      for (const [, pos] of livePosEntries) {
        // MUST check closeResult.closed before marking terminal — closeLiveOrder
        // can fail (zero_balance / API error / MEXC downtime) and return
        // { closed:false }, in which case the real MEXC balance is still
        // sitting untouched on the exchange. Previously this loop ignored
        // that return value and force-set status:'stopped' unconditionally,
        // with no liveOrder.closedAt (only closeLiveOrder itself sets that,
        // on an actual successful sell). A position stopped-without-closedAt
        // was then invisible to adoptManualHoldings' alreadyTracked check
        // (which excludes anything status:'stopped'), so next cycle saw the
        // still-real balance as "untracked" and re-adopted it as brand new —
        // then the same failing sell repeated, stopping it again, forever.
        // Result: a fresh MANUAL_ADOPTED_* position + duplicate trade-log
        // "open" row every single decide cycle (~5 min) for as long as the
        // panic regime and the underlying sell failure both persisted.
        const closeResult = await closeLiveOrder(pos, `market guard: ${guard.reasons[0]}`, guardSells);
        if (!closeResult.closed) {
          failedCount++;
          console.log(`  ⚠️  Emergency close failed for ${pos.base} (${closeResult.reason}) — left tracked, will retry next cycle`);
          logAudit('market_guard_close_failed', { base: pos.base, reason: closeResult.reason });
          continue; // leave status/liveOrder untouched — real balance is still open on the exchange
        }
        pos.status          = 'stopped';
        pos.statusChangedAt = Date.now();
        pos.rotatedOut      = true;
      }
      savePositions(positions);
      await pushPositionsToGitHub(positions);
      await sendTelegram(
        `🚨 *MARKET GUARD — EMERGENCY CLOSE* — ${new Date().toUTCString().slice(17, 22)} UTC\n` +
        `  Reason: ${guard.reasons[0]}\n` +
        `  Closed ${livePosEntries.length - failedCount}/${livePosEntries.length} live position(s)${failedCount ? ` — ${failedCount} sell(s) FAILED, see logs, will retry next cycle` : ''}\n` +
        `  _New buys blocked until market stabilises_`
      );
      for (const m of guardSells) await sendTelegram(m);
    }
  }

  // Apply guard size multiplier to the effective USD size for this cycle
  // (only meaningful in 'usd' mode — 'percent' mode recomputes size from
  // live balance in mexc-trader.js's executeAutoBuys, using this same
  // guard.sizeMult passed through as effectiveGuardSizeMult)
  const guardedUsdSize = guard.sizeMult < 1
    ? parseFloat((effectiveUsdSize * guard.sizeMult).toFixed(2))
    : effectiveUsdSize;

  if (guard.sizeMult < 1) {
    if (effectiveSizeMode === 'percent') {
      console.log(`  📉  Market guard active — sizing to ${(effectiveSizePct * guard.sizeMult).toFixed(1)}% of balance (×${guard.sizeMult} guard multiplier)`);
    } else {
      console.log(`  📉  Position size reduced: $${effectiveUsdSize} → $${guardedUsdSize} (×${guard.sizeMult})`);
    }
  }

  // If a genuine hard-stop gate fired (BTC panic closeAll, circuit breaker,
  // time blackout), skip all new buys this cycle — no per-symbol exception
  // applies to these. A pure BTC 4H regime block (guard.canBuy=false but
  // guard.hardBlocked=false) falls through instead, so individual symbols
  // still get evaluated against the Alpha Exception below.
  if (guard.hardBlocked) {
    console.log('  🛡  Buy gates blocked — no new positions opened this cycle.');
    saveMarketData(resetPeaks(market));
    saveCooldowns(loadCooldowns());
    saveAlertState(pruneAlertState(loadAlertState()));
    logAudit('buy_blocked_by_guard', { reasons: guard.reasons });
    await pushHeartbeatToGitHub(Date.now());
    console.log('\n✅  Job B complete (guard active).\n');
    return;
  }
  if (!guard.canBuy && guard.btcRegimeBlocked) {
    console.log('  🛡  BTC 4H regime block active — only symbols passing the Alpha Exception can buy this cycle.');
  }

  const alertState = pruneAlertState(loadAlertState());
  const candidates = [];
  const buyHistory = loadHistory(); // for the bad-history gate below — separate load from the post-close save above, this file only reads it

  for (const [pair, entry] of entries) {
    // Session gate
    if (entry.marketClosed) continue;
    if (entry.session === 'pre_market'  && !ALLOW_PRE_MARKET) continue;
    if (entry.session === 'after_hours' && !ALLOW_AH) continue;

    // Score gate
    const evald = evaluateSymbol(entry);

    // ── Bad-history buy gate ──
    // Runs before the LB_MIN_SCORE comparison so a hard-gated symbol never
    // becomes a candidate at all, and a soft-penalized one has its penalty
    // actually count toward whether it clears the bar (not just cosmetic).
    const symBase  = pair.replace('USDT', '').replace(/\.\w+$/, '');
    const symHist  = getHistoryStrength(buyHistory, symBase, HIST_GATE_LOOKBACK_DAYS);
    if (symHist.sample >= HIST_GATE_HARD_MIN_SAMPLE && symHist.winRate !== null && symHist.winRate <= HIST_GATE_HARD_MAX_WINRATE) {
      console.log(`  🚫  ${pair} — bad-history gate: ${Math.round(symHist.winRate*100)}% win rate over ${symHist.sample} closes (≥${HIST_GATE_HARD_MIN_SAMPLE} sample, ≤${Math.round(HIST_GATE_HARD_MAX_WINRATE*100)}%) — skipping entirely`);
      continue;
    }
    if (symHist.sample >= HIST_GATE_SOFT_MIN_SAMPLE && symHist.winRate !== null && symHist.winRate <= HIST_GATE_SOFT_MAX_WINRATE) {
      evald.conv -= HIST_GATE_SOFT_PENALTY;
    }

    // ── Same-day repeat-failure pause ──
    // Separate from the 30-day gate above — catches a fast repeated
    // failure pattern (2+ losses in a few hours) that the 30-day gate is
    // too slow to react to. Hard skip, not a conv penalty — a genuine
    // "this isn't working today" pattern shouldn't just be discounted,
    // it should wait. Does NOT block a symbol after a single loss or a
    // symbol simply re-qualifying on a real signal (e.g. a BTC bounce
    // dragging an alt back up after one stop-out) — only 2+ losses within
    // the short window trips this.
    const samedayCheck = checkSamedayFailures(buyHistory, symBase);
    if (samedayCheck.paused) {
      console.log(`  ⏸  ${pair} — same-day failure pause: ${samedayCheck.reason}`);
      continue;
    }

    if (evald.conv < LB_MIN_SCORE)          continue;
    if (SKIP_SETUPS.has(evald.setup.label)) continue;

    // ── P2 signal-type gate (dev-team "Buy Priority / Rotation / Sell
    // Intelligence" doc) ──────────────────────────────────────────────
    // Previously nothing here checked the signal classification at all —
    // only the numeric conv score above. signal-evaluator.js's AVOID/WEAK/
    // FALLING KNIFE branches are reachable with a high conv score in some
    // combinations (e.g. FALLING KNIFE's bias4h==='BEAR' branch doesn't
    // require conv<=0), so a candidate whose signal actively says "don't
    // buy this" could still reach the Entry Quality Check and beyond on
    // conv alone. Explicit allowlist closes that gap: only BUY, EARLY BUY,
    // and WATCH are P2-eligible signal types. CAP BUY is exempt — it's
    // already the deliberate extreme-shock exception to every other
    // STRATEGY qualification gate here (bull confirmation, trigger status,
    // impulseExhaustion/breakoutDistance in the Entry Quality Check), so
    // it shouldn't be blocked by a signal classification that doesn't
    // account for an extreme-shock event in the first place.
    //
    // NOTE: reads entry.signal (the market-data.json field market-fetcher.js
    // sets from classifySignal(r), same source the GUI's SIGNAL column
    // uses) — NOT evald.signal. evaluateSymbol() above returns
    // {conv, setup, shock, obi, source} and has never had a `signal`
    // property, so the original version of this gate (evald.signal) was
    // always comparing against `undefined` — silently rejecting every
    // non-CAP-BUY candidate that reached this line, every cycle, since the
    // gate was added. Fixed to read the field that actually holds it.
    const isCapBuyEarly = entry.assetType === 'crypto' && (entry.capBuy?.isCapBuy ?? false);
    const P2_ELIGIBLE_SIGNALS = new Set(['BUY', 'EARLY BUY', 'WATCH']);
    if (!isCapBuyEarly && !P2_ELIGIBLE_SIGNALS.has(entry.signal)) {
      console.log(`  ⏭  ${pair} signal=${entry.signal} — not P2-eligible (AVOID/WEAK/FALLING KNIFE never buy, regardless of conv)`);
      continue;
    }
    // "P2 rejects WATCH/EARLY BUY + SETUP" — belt-and-suspenders on top of
    // the triggerStatus gate further below (which already blocks non-
    // BREAKOUT/TRIGGERING triggers for every signal type); this catches
    // the specific WATCH/EARLY BUY + entryState=SETUP combo explicitly,
    // in case triggerStatus and entryState ever disagree (e.g. stale
    // trigger data lagging a fresh entryState read). CAP BUY exempt for
    // the same reason as above.
    if (!isCapBuyEarly && (entry.signal === 'WATCH' || entry.signal === 'EARLY BUY') && entry.entryState === 'SETUP') {
      console.log(`  ⏭  ${pair} signal=${entry.signal} + entryState=SETUP — rejected, too early (P2 requires BREAKOUT/TRIGGERING)`);
      continue;
    }

    // 4H trend persistence gate — applies to EVERY buy candidate,
    // independent of BTC regime state. bull4hCount is maintained by
    // market-fetcher.js (this file only consumes it); requiring it to
    // have held for BUY_BULL4H_COUNT_MIN consecutive fetch cycles (~5min
    // each) filters out a bias4h reading that just flipped to "BULL 4H"
    // this cycle and may reverse next cycle, before committing real money.
    if (entry.assetType === 'crypto') {
      const persistence = checkBull4hPersistence(entry);
      if (!persistence.allowed) {
        console.log(`  ⏳  ${pair} — 4H bull trend only ${persistence.count} cycle(s) old (need ≥${process.env.BUY_BULL4H_COUNT_MIN || '2'}) — skipping, possible short-lived flip`);
        continue;
      }
    }

    // v15 Market Intelligence gate — BTC risk score / breadth / relative
    // strength bands from market-state.json (Market Intelligence Engine).
    // Additive to, and runs before, the existing bias4h-label Layer 6 gate
    // below. Skips silently (notReady) until market-state.json exists.
    if (entry.assetType === 'crypto') {
      const miGate = checkMarketIntelligenceGate(marketState, { ...entry, symbol: pair }, marketState.symbols?.[pair], market.global || {});
      if (!miGate.notReady && !miGate.allowed) {
        console.log(`  🧠  ${pair} — Market Intelligence gate blocked (${miGate.reasons.join('; ')})`);
        continue;
      }
      if (!miGate.notReady && miGate.riskScoreExceptionUsed) {
        console.log(`  ✅  ${pair} — BTC risk-score block bypassed via relative-strength exception (${miGate.riskScoreExceptionChecks.join(', ')})`);
      }
      if (!miGate.notReady && miGate.bullRequired != null) {
        const persistence = checkBull4hPersistence(entry);
        if (persistence.count < miGate.bullRequired) {
          console.log(`  🧠  ${pair} — dynamic bull4h requires ${miGate.bullRequired} cycle(s) at BTC risk ${miGate.btcRiskScore} (${miGate.btcRiskBand}), only ${persistence.count} — skipping`);
          continue;
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ENTRY QUALITY CHECK — per "Leaderboard Decider / Buy Alert Improvement
    // Notes v2": FETCH → Market State → WATCH/EARLY SETUP → 5m BREAKOUT
    // detected → Entry Quality Check → PASS? YES → BUY, NO → WAIT.
    //
    // Architectural rule from that doc: a strong Grade A signal does NOT
    // directly authorize a buy — grade (calcGrade) is never consulted here.
    // Score/history/persistence/Market-Intelligence gates above this point
    // qualify a CANDIDATE; everything below decides whether THIS entry, right
    // now, is still actionable. Only applies to crypto — stocks have no 5m
    // trigger/order-book layer to evaluate.
    //
    // CAP BUY is the one deliberate exemption throughout (breakoutDistance,
    // impulseExhaustion) — it's itself an extreme-shock event (calcCapBuy)
    // where "wait for a clean breakout" doesn't apply — the shock IS the
    // trigger. See entry-quality-check.js for the full per-check reasoning.
    const isCapBuyForTrigger = entry.assetType === 'crypto' && (entry.capBuy?.isCapBuy ?? false);

    if (entry.assetType === 'crypto') {
      // ── "5m BREAKOUT detected" — still WATCH/EARLY SETUP until then ──
      // A candidate whose short-timeframe trigger (calcSpikeTrigger,
      // buy-intelligence.js) hasn't confirmed a breakout yet is a real
      // setup, not yet a BUY — send it back to WAIT rather than into the
      // Entry Quality Check (which only judges an entry that's already
      // happening). RETEST exception: a RETEST entryState (pullback 0-1%
      // off the trigger level) with a TRIGGERING trigger is buy-eligible
      // even without the final BREAKOUT candle — setup confirmed, price
      // sitting at the retest. entry.triggerStatus == null (insufficient
      // 5m history, or BUY_ENABLE_SPIKE_TRIGGER=false) does NOT block —
      // same backward-compatible fallback as signal-evaluator.js. FAILED
      // is handled inside the Entry Quality Check itself (FAILED_BREAKOUT).
      const retestTriggerOk = entry.entryState === 'RETEST' &&
        (entry.triggerStatus === 'BREAKOUT' || entry.triggerStatus === 'TRIGGERING');

      // ── Scout entry — opt-in, smaller-size buy at TRIGGERING ────────────
      // Structurally-qualified candidate whose 5m trigger is TRIGGERING
      // (setup confirmed, one of volume/CVD/BTC confirmation still
      // missing) but entryState ISN'T RETEST (so the exception above
      // doesn't already cover it). Off by default — BUY_SCOUT_ENABLE must
      // be explicitly turned on. Unlike the RETEST exception (full size),
      // this is deliberately reduced-size (executeAutoBuys reads
      // entry.scoutBuy to size it at BUY_SCOUT_SIZE_PCT) since it's
      // earlier/less confirmed than even the RETEST case. Purpose: capture
      // some of the early move on a real breakout while capping the cost
      // of a stall — measure via entryTriggerStatus/entryStateAtBuy on
      // symbol-history.json before ever widening this further.
      const scoutTriggerOk = BUY_SCOUT_ENABLE && !retestTriggerOk &&
        entry.triggerStatus === 'TRIGGERING' && entryOkForScout(entry);
      if (scoutTriggerOk) entry.scoutBuy = true;

      if (!isCapBuyForTrigger && entry.triggerStatus != null &&
          entry.triggerStatus !== 'BREAKOUT' && entry.triggerStatus !== 'FAILED' &&
          !retestTriggerOk && !scoutTriggerOk) {
        console.log(`  ⏳  ${pair} — trigger not confirmed yet (${entry.triggerStatus}, score ${entry.triggerScore ?? '—'}) — setup qualifies, waiting for 5m breakout confirmation`);
        continue;
      }
      if (retestTriggerOk && entry.triggerStatus === 'TRIGGERING') {
        console.log(`  ✅  ${pair} — entryState=RETEST with TRIGGERING trigger (score ${entry.triggerScore ?? '—'}) — allowed via RETEST exception`);
      }
      if (scoutTriggerOk) {
        console.log(`  🔎  ${pair} — TRIGGERING (score ${entry.triggerScore ?? '—'}), entryState=${entry.entryState} — allowed as reduced-size SCOUT buy (BUY_SCOUT_SIZE_PCT=${BUY_SCOUT_SIZE_PCT}%)`);
      }

      // ── BTC condition (row 8 of the Entry Quality Check) ──
      // Precomputed here since it needs guard/market context the standalone
      // checkEntryQuality() module deliberately doesn't have (kept in
      // market-guard.js, single source of truth). Combines Layer 6's BTC
      // regime block (with per-candidate Alpha Exception — EXHAUSTED_BULL
      // has no exception route, per the Market Intelligence Enhancement
      // Proposal v2 Scenario 2; only a BEAR-labeled block gets evaluated)
      // and the Fear & Greed divergence gate (BTC dropping + this symbol
      // also dropping → block; this symbol UP while BTC is down → real
      // relative strength → allow, e.g. IMX +4.29% while BTC was red).
      let btcCheck = { pass: true, reason: null };
      if (guard.btcRegimeBlocked) {
        if (!guard.btcRegimeAllowsAlpha) {
          btcCheck = { pass: false, reason: `BTC regime block (${guard.btcRegimeName || 'unknown'}) — no Alpha Exception available for this regime` };
        } else {
          const alpha = checkBtcAlphaException({ ...entry, d: entry.d, conv: evald.conv });
          if (!alpha.allowed) {
            btcCheck = { pass: false, reason: `BTC regime block, no Alpha Exception (failed: ${alpha.failedChecks.join(', ')})` };
          } else {
            const rs = calcRelativeStrength(entry, market.global || {});
            console.log(`  ✅  ${pair} — Alpha Exception passed (${alpha.passedChecks.join(', ')})${rs.rs !== null ? ` — RS vs BTC: ${rs.rs > 0 ? '+' : ''}${rs.rs}%` : ''}`);
          }
        }
      }
      if (btcCheck.pass && guard.fearRegime) {
        const symChg = parseFloat(entry.d?.chg ?? entry.chg ?? 0);
        if (!isDivergingFromBtc(symChg, guard.btcChg)) {
          btcCheck = { pass: false, reason: `Extreme Fear + no BTC divergence (symChg:${symChg}% btcChg:${guard.btcChg}%)` };
        } else {
          console.log(`  ✅  ${pair} — Extreme Fear but diverging +${symChg}% vs BTC ${guard.btcChg}% — allowing at ${guard.sizeMult * 100}% size`);
        }
      }

      // ── Run the 8-check Entry Quality Check (entry-quality-check.js) ──
      // breakoutDistance / triggerAge / impulseExhaustion / bpp / cvd /
      // volumeFollowThrough / failedBreakout / btcCondition. ANY failure
      // blocks the buy with an explicit code (ENTRY_EXTENDED, TRIGGER_STALE,
      // IMPULSE_EXHAUSTED, BPP_FADING, CVD_WEAK, VOLUME_THIN,
      // FAILED_BREAKOUT, BTC_BLOCK) regardless of how strong conv/whale/CVD
      // look elsewhere — mirrors the FAILED-trigger reasoning that already
      // existed here: those inputs support a reversal hypothesis, they
      // don't get to override an active entry-quality block.
      const eq = checkEntryQuality({ entry, pair, alertState, isCapBuy: isCapBuyForTrigger, btcCheck });
      if (!eq.pass) {
        const summary = eq.blockers.map(b => `${b.code}: ${b.reason}`).join(' · ');
        console.log(`  🛑  ${pair} — Entry Quality Check FAILED — ${summary}`);
        logAudit('entry_quality_blocked', { pair, blockers: eq.blockers.map(b => b.code) });
        continue;
      }

      // ══════════════════════════════════════════════════════════════════
      // ST5/ST15 TIMING ENGINE — per the "ST5/ST15 Timing Engine" dev doc
      // (22 Aug 2026, supersedes the simpler alignment-only gate from the
      // earlier WATCH+ST doc): a SEPARATE entry-timing/confirmation layer
      // on top of the Entry Quality Check above, not a conviction-score
      // weight. Reads the CURRENT ST5/ST15 state (direction, ATR-normalized
      // distance/extension, slope, retest) — no fresh cross required,
      // that's P0/P1's job (STEP 1.6/1.7 above). CAP BUY is exempt for the
      // same reason it's exempt everywhere else in this block — a
      // deliberate extreme-shock exception, not a candidate this timing
      // layer is meant to judge. See st-timing-engine.js for full
      // per-condition reasoning.
      if (!isCapBuyForTrigger) {
        const timing = evaluateSTTiming(entry, marketState);
        if (timing.p2State === 'BLOCK') {
          console.log(`  📉🔪  ${pair} — ST timing BLOCK — ${timing.reason}`);
          logAudit('st_timing_blocked', { pair, p2State: timing.p2State, timingScore: timing.timingScore, reason: timing.reason });
          continue;
        }
        if (timing.p2State === 'WAIT_RETEST' || timing.p2State === 'WAIT') {
          console.log(`  ⏸  ${pair} — ST timing ${timing.p2State} (score ${timing.timingScore}/95) — ${timing.reason}`);
          logAudit('st_timing_wait', { pair, p2State: timing.p2State, timingScore: timing.timingScore, reason: timing.reason });
          continue;
        }
        // timing.p2State === 'READY'
        console.log(`  ✅  ${pair} — ST timing READY (score ${timing.timingScore}/95, ${timing.alignment?.alignment}) — ${timing.reason}`);
        // ── P2-A/P2-B/P2-C trigger classification ──
        // Per the "P2 Continuation Strategy" dev doc §8/§10: log the exact
        // reason and carry it on `entry` so it survives to the position
        // record below when this candidate actually gets bought. This is a
        // label on top of READY, not an additional gate — a READY P2-C
        // candidate buys exactly as it did before this change.
        entry.p2Trigger = timing.p2Trigger;
        entry.p2EventKey = timing.p2EventKey;
        if (timing.p2Trigger !== 'P2-C-NORMAL') {
          console.log(`  🔁  ${pair} — ${timing.p2Trigger}`);
        }
        logAudit('p2_trigger_classified', { pair, p2Trigger: timing.p2Trigger, p2EventKey: timing.p2EventKey });
      }
    }

    // CAP BUY bypasses bull confirmation gate
    const isCapBuy = entry.assetType === 'crypto' && (entry.capBuy?.isCapBuy ?? false);
    if (!isCapBuy && (entry.bullConf ?? 0) < LB_BULL_CONF_MIN) {
      console.log(`  ⏭  ${pair} bullConf:${entry.bullConf}/10 < ${LB_BULL_CONF_MIN}`);
      continue;
    }

    // Cooldown gate
    const cdKey = cooldownKey(pair, entry.assetType);
    if (isOnCooldown(cooldowns, cdKey, entry.assetType)) {
      console.log(`  🔕  ${pair} — cooldown`);
      continue;
    }
    if (entry.assetType === 'crypto' && isOnStopCooldown(cooldowns, pair)) {
      console.log(`  🔕  ${pair} — stop-loss cooldown (${STOP_COOLDOWN_MIN}min)`);
      continue;
    }

    // Open position gate — block on active states only
    // Matches by BASE ASSET across ALL tracked keys, not just an exact
    // sym-key match. adoptManualHoldings tracks manually-bought coins under
    // a bare key (e.g. 'LINKUSDT'), while this buy-scan builds its own key
    // via buildSymKey (e.g. 'BINANCE:LINKUSDT') — an exact-key lookup here
    // would miss an existing bare-keyed entry entirely and create a SECOND,
    // duplicate tracked position for the same real asset. A duplicate like
    // that silently occupies an extra TRADE_MAX_CONCURRENT_LIVE slot even
    // after the "real" copy gets sold, since only one of the two keys
    // actually gets closed by a sell.
    const sym = buildSymKey(pair);
    const base = pair.replace('USDT', '').replace(/\.\w+$/, '');
    const existingKey = Object.keys(positions).find(k => {
      const p = positions[k];
      return p.base === base && p.assetType === entry.assetType;
    });
    const existingPos = existingKey ? positions[existingKey] : undefined;
    if (existingPos) {
      // tp1_hit has two sub-states (see position-monitor.js): still holding
      // to T2 (no exitPrice — a real position, do NOT touch it) vs actually
      // sold at T1 (exitPrice set — genuinely terminal). Only the latter is
      // safe to evict/replace here; the former must stay tracked exactly
      // like position-monitor.js already protects it, or this gate would
      // silently delete the live tracking record for a real open position
      // (and open a duplicate) the moment TERMINAL_EVICT_MS elapses.
      const isTerminal = ['stopped', 'tp2_hit'].includes(existingPos.status)
        || (existingPos.status === 'tp1_hit' && !!existingPos.exitPrice);
      if (!isTerminal) {
        console.log(`  ⏭  ${pair} — open position (${existingPos.status})`);
        continue;
      }
      // Terminal but not yet evicted — check if past eviction window
      const termDelay = TERMINAL_EVICT_MS[existingPos.status] || 0;
      const changedAt = existingPos.statusChangedAt || existingPos.alertedAt || 0;
      if (Date.now() - changedAt < termDelay) {
        console.log(`  ⏭  ${pair} — terminal (${existingPos.status}), waiting for eviction`);
        continue;
      }
      // Past eviction window — clear it now (using whichever key it was
      // ACTUALLY tracked under, which may differ from buildSymKey(pair))
      console.log(`  ♻️  ${pair} — clearing terminal (${existingPos.status}), slot available`);
      delete positions[existingKey];
    }

    candidates.push({ pair, sym, entry, evald, cdKey, isCapBuy });
  }

  if (!candidates.length) {
    console.log('  ✓  No new buy signals this cycle (blocked by cooldown/gates)');

    // MOM WATCH — covers the case that produced today's log: a candidate
    // reached the pre-screen (anyCandidate true), but market guard / MI
    // gate / persistence / cooldown filtered every one of them out before
    // candidates was built. A real momentum burst on a filtered symbol
    // would otherwise vanish here with zero visibility.
    const momLines = collectMomWatchAlerts(entries, cooldowns);
    if (momLines.length) {
      await sendTelegram([
        `⚡ *Alpha Terminal — MOM WATCH*`,
        `_informational only — not a buy signal, no execution triggered · candidates were filtered by guard/gates this cycle_`,
        '', momLines.join('\n\n'),
      ].join('\n'));
    }

    saveMarketData(resetPeaks(market));
    saveCooldowns(cooldowns);
    saveAlertState(alertState);
    logAudit('buy_cycle_complete', { signalsFound: 0, momWatchAlerts: momLines.length });
    logAudit('job_complete');
    await pushHeartbeatToGitHub(Date.now());
    console.log(`\n✅  Job B complete${momLines.length ? ` (${momLines.length} MOM WATCH heads-up sent)` : ''}.\n`);
    return;
  }

  // Open new positions
  const buyAlerts = [];
  for (const { pair, sym, entry, evald, cdKey } of candidates) {
    markCooldown(cooldowns, cdKey);
    alertState[pair] = { lastLabel: evald.setup.label, lastConv: evald.conv, lastSeenAt: Date.now() };

    const levels = calcEntryLevels(entry.price, evald.shock);
    const now    = Date.now();

    positions[sym] = {
      sym,
      base:           pair.replace('USDT', '').replace(/\.\w+$/, ''),
      assetType:      entry.assetType,
      exchangePrefix: entry.exchangePrefix,
      session:        entry.session,
      setup:          evald.setup.label,
      // Always 'bull' — SKIP_SETUPS already filters 'SHORT SETUP' out of
      // this buy loop above, so this ternary was dead in practice, but it's
      // also just wrong: this bot only ever holds MEXC SPOT longs (no
      // shorting), and position-monitor.js's stop/T1/T2 checks are gated
      // on `pos.dir !== 'bear'` with NO bear-side equivalent anywhere — so
      // dir:'bear' silently disables stop-loss/take-profit for that
      // position forever. Hardcoded here to stay correct even if the
      // SKIP_SETUPS gate above ever changes. (Same fix applied to the
      // manual-holding adoption path in mexc-trader.js, which had no such
      // gate and was the actual live bug — see the comment there.)
      dir:            'bull',
      alertedAt:      now,
      holdLockUntil:  now + LB_HOLD_LOCK * 60000,
      entryPrice:     levels ? parseFloat(levels.entry) : entry.price,
      stop:           levels ? parseFloat(levels.stop)  : 0,
      t1:             levels ? parseFloat(levels.t1)    : 0,
      t2:             levels ? parseFloat(levels.t2)    : 0,
      score:          evald.conv,
      spikeScore:     evald.shock,
      exitAlertedAt:  null,
      tier1AlertedAt: null,
      status:         'watching',
      source:         'headless_v11.0',
      scoreSource:    evald.source,
      // P2-A-PULLBACK-RECLAIM | P2-B-CONSOLIDATION-BREAKOUT | P2-C-NORMAL —
      // absent (isCapBuy / entryState-RETEST-exception / SCOUT paths never
      // run the ST timing engine, so never set this) means "not classified",
      // distinct from an explicit P2-C.
      p2Trigger:      entry.p2Trigger || undefined,
    };

    buyAlerts.push({ pair, sym, levels, evald, price: entry.price, chg: entry.chg, d: entry.d, entry });
    console.log(`  🟢  ${pair} [${evald.setup.label}]${entry.p2Trigger && entry.p2Trigger !== 'P2-C-NORMAL' ? ` [${entry.p2Trigger}]` : ''} score:${evald.conv} → ${sym}`);
    logAudit('position_opened', { pair, sym, setup: evald.setup.label, score: evald.conv, p2Trigger: entry.p2Trigger || null });
  }

  // ── Rank by CURRENT signal first, past spike history as a bonus only ──
  // Computed here (before save) so positions.json itself carries the same
  // recommended/rank/caution tags the Telegram message uses — Position
  // Tracker in the browser can then badge ⭐ inline, no separate panel.
  //
  // Why current-first: a symbol's 30d win rate mostly reflects the regime
  // it traded in (BTC/market beta dragging everything down), not whether
  // *this* setup is good. So history can only ADD to the rank (proven
  // repeaters get boosted), never subtract — a real reversal spike with a
  // rough recent record still competes on its own technical merit.
  const history      = loadHistory();
  const showRecoTags = buyAlerts.length >= RECO_MIN_SIGNALS;
  const base = a => a.pair.replace('USDT', '').replace(/\.\w+$/, '');

  const HIST_BOOST_WEIGHT  = parseFloat(process.env.LB_RECO_HIST_BOOST_WEIGHT || '0.5');  // how much a clean track record can add on top of current signal
  const CAUTION_WIN_RATE   = parseFloat(process.env.LB_RECO_CAUTION_WIN_RATE  || '0.3');  // below this win rate → caution note
  const CAUTION_MIN_SAMPLE = parseInt(process.env.LB_RECO_CAUTION_MIN_SAMPLE  || '3');    // need at least this many closes for the caution note to be meaningful

  function currentSignalStrength(a) {
    // Normalize conviction score and bull-confirmation to ~0-1 so they're
    // comparable to the history bonus below.
    const convNorm     = Math.max(0, Math.min(1, (a.evald.conv - LB_MIN_SCORE) / 10));
    const bullConfNorm = Math.max(0, Math.min(1, (a.entry.bullConf || 0) / 10));
    return 0.7 * convNorm + 0.3 * bullConfNorm;
  }

  const ranked = buyAlerts
    .map(a => {
      const hist      = getHistoryStrength(history, base(a), RECO_LOOKBACK_DAYS);
      const curStr     = currentSignalStrength(a);
      const rankScore  = curStr + HIST_BOOST_WEIGHT * Math.max(0, hist.strength); // history floors at 0 — never a penalty
      const caution    = hist.sample >= CAUTION_MIN_SAMPLE && hist.winRate !== null && hist.winRate < CAUTION_WIN_RATE;
      return { a, hist, curStr, rankScore, caution };
    })
    .sort((x, y) => (y.rankScore - x.rankScore) || (y.a.evald.conv - x.a.evald.conv));

  if (showRecoTags) {
    ranked.slice(0, RECO_TOP_N).forEach(r => { r.recommended = true; });
  }

  // ── Tag positions.json with the same ranking, before it's saved ──
  for (const { a, hist, rankScore, recommended, caution } of ranked) {
    const p = positions[a.sym];
    if (!p) continue;
    p.recommended = !!recommended;   // starred in Position Tracker
    p.rankScore   = parseFloat(rankScore.toFixed(3));
    p.histWinRate = hist.winRate;    // null if no history yet
    p.histSample  = hist.sample;
    p.caution     = caution;         // rough recent record — reversal bet, not a repeat pattern
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MEXC AUTO-TRADE — rotation + star-pick buys (delegated to mexc-trader.js)
  // ══════════════════════════════════════════════════════════════════════════
  const utc = new Date().toUTCString().slice(17, 22) + ' UTC';
  // Note: separate from monitor's closedOutcomes above — this was a latent
  // bug in the monolith (rotation referenced an undeclared `closedOutcomes`
  // in main()'s scope, which would have thrown ReferenceError the first time
  // an A/A+ signal fired). Fixed by giving mexc-trader its own outcomes array
  // and recording it to history in a second pass, right after execution.
  const rotationOutcomes = [];

  await executeTradeCycle({
    candidates, positions, market, tradeState,
    closedOutcomes: rotationOutcomes, utc,
    effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount, effectiveUsdSize: guardedUsdSize, effectiveMaxLive,
    effectiveSizeMode, effectiveSizePct, effectiveGuardSizeMult: guard.sizeMult,
    ranked, showRecoTags, marketState,
  });

  if (rotationOutcomes.length) {
    let hist = loadHistory();
    hist.push(...rotationOutcomes);
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
    hist = hist.filter(e => e.closedAt >= cutoff);
    if (hist.length > HISTORY_MAX_ROWS) hist = hist.slice(hist.length - HISTORY_MAX_ROWS);
    saveHistory(hist);
    logAudit('history_recorded', { rows: rotationOutcomes.length, totalKept: hist.length, source: 'rotation' });
  }

  savePositions(positions);
  saveCooldowns(cooldowns);
  saveAlertState(alertState);
  saveMarketData(resetPeaks(market));
  await pushPositionsToGitHub(positions);

  // Telegram BUY alerts
  const lines = ranked.map(({ a, hist, recommended, caution }) => {
    const l          = a.levels;
    const peakNote   = a.evald.source === 'peak' ? ' _(peak)_' : '';
    const assetBadge = a.entry.assetType === 'stock' ? ' 📊' : '';
    const sessionTag = a.entry.session !== 'open' && a.entry.session !== '24/7'
      ? ` _(${a.entry.session})_` : '';
    const star       = recommended ? '⭐ ' : '';
    const histLine    = showRecoTags
      ? (hist.sample > 0
          ? `  📈 Past ${RECO_LOOKBACK_DAYS}d: ${Math.round(hist.winRate * hist.sample)}W-${hist.sample - Math.round(hist.winRate * hist.sample)}L (${Math.round(hist.winRate * 100)}%) avg ${hist.avgPnl >= 0 ? '+' : ''}${hist.avgPnl.toFixed(2)}%`
          : `  📈 No trade history yet — ranked on signal strength`)
      : '';
    const cautionLine = caution
      ? `  ⚠ _Rough recent record (${Math.round(hist.winRate*100)}% win, ${hist.sample} closes) — treat as a reversal bet, not a repeat pattern_`
      : '';
    return [
      `${star}${a.evald.setup.emoji} *${a.pair.replace('USDT','')}*${assetBadge} — ${a.evald.setup.label} [${a.evald.conv} pts]${peakNote}${sessionTag}`,
      a.entry.whale ? `  ${a.entry.whale.emoji} Whale ${a.entry.whale.score}/100 · Flow: ${a.entry.flow||'—'} · Grade: ${a.entry.grade||'—'} (${a.entry.successProb||'—'}% confidence)` : '',
      `  Setup: ${a.entry.archetype||'—'} · BullConf: ${a.entry.bullConf??'—'}/10`,
      `  Price $${a.price}  Chg ${a.chg>0?'+':''}${a.chg?.toFixed(2)}%`,
      `  Entry $${l?.entry||'—'}  Stop $${l?.stop||'—'}  T1 $${l?.t1||'—'}  T2 $${l?.t2||'—'}  R:R ${l?.rr||'—'}`,
      histLine,
      cautionLine,
      `  _Pos: ${a.sym}_`,
    ].filter(Boolean).join('\n');
  });

  const recoHeader = showRecoTags
    ? `_⭐ Top ${Math.min(RECO_TOP_N, buyAlerts.length)} of ${buyAlerts.length} — ranked on current signal, clean track record adds a bonus (never a penalty)_`
    : `_${buyAlerts.length} signal(s) · v11.0 · min score ${LB_MIN_SCORE}_`;

  const msg = [
    `🔔 *Leaderboard BUY Alert* — ${utc}`,
    recoHeader,
    '', lines.join('\n\n'), '',
    `_Stop/T1/T2/exit monitored headlessly every 15 min_`,
  ].join('\n');

  await sendTelegram(msg);
  logAudit('buy_cycle_complete', {
    signalsFound: candidates.length,
    positionsOpened: buyAlerts.length,
    recommended: showRecoTags ? ranked.slice(0, RECO_TOP_N).map(r => base(r.a)) : [],
    caution: ranked.filter(r => r.caution).map(r => base(r.a)),
  });

  // ── Live-balances snapshot for the GUI's Trade Journal cross-check ──
  // Only meaningful in live mode — paper has no real exchange balance. Runs
  // every cycle (not just on rotation) so the GUI always has a fresh view of
  // what's actually sitting on MEXC right now, including anything bought
  // manually outside the bot.
  if (effectiveTradeMode === 'live' && MEXC_API_KEY && MEXC_API_SECRET) {
    try {
      const balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
      await pushLiveBalancesToGitHub(balances);
    } catch (e) {
      console.warn(`[live-balances] ⚠ ${e.message}`);
      logAudit('live_balances_fetch_failed', { error: e.message });
    }
  }

  logAudit('job_complete');
  await pushHeartbeatToGitHub(Date.now());
  await pushAuditLogToGitHub(loadAuditLog());
  console.log('\n✅  Job B complete.\n');
}

main().catch(err => {
  console.error('[leaderboard-decider] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
