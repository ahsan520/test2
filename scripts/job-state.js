// ══════════════════════════════════════════════════════════════════════════════
// job-state.js — shared I/O layer for the Job B pipeline
//
// Every module in the split (leaderboard-decider, position-monitor, mexc-trader,
// telegram-commands) reads/writes the same handful of JSON state files and the
// same handful of env-derived constants. Centralizing them here avoids each
// module re-declaring its own copy of MEXC_API_KEY, TERMINAL_EVICT_MS, etc. —
// and avoids a circular-import mess between the other four files.
//
// This file has NO business logic — just paths, env constants, load/save,
// logAudit, and the GitHub positions.json push.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';

// ── Paths ──
const MARKET_DATA_PATH    = path.join(process.cwd(), 'market-data.json');
const MARKET_STATE_PATH   = path.join(process.cwd(), 'market-state.json');
const POSITIONS_PATH      = path.join(process.cwd(), 'positions.json');
const LB_ALERT_STATE_PATH = path.join(process.cwd(), 'lb-alert-state.json');
const AUDIT_PATH          = path.join(process.cwd(), 'audit.json');
const COOLDOWN_STATE_PATH = path.join(process.cwd(), '.lb-scan-state.json');
const CVD_STATE_PATH      = path.join(process.cwd(), '.cvd-decline-state.json');
const SYMBOL_HISTORY_PATH = path.join(process.cwd(), 'symbol-history.json');
const TRADE_STATE_PATH    = path.join(process.cwd(), 'trade-state.json');
const TRADE_LOG_PATH      = path.join(process.cwd(), 'trade-log.json');
const PAPER_BALANCE_PATH  = path.join(process.cwd(), 'paper-balance.json');
const LIVE_BALANCES_PATH  = path.join(process.cwd(), 'mexc-live-balances.json');
const HEARTBEAT_PATH      = path.join(process.cwd(), 'heartbeat.json');
const MEXC_AUTH_ALERT_PATH = path.join(process.cwd(), '.mexc-auth-alert-state.json');

// ── Shared env constants ──
export const DRY_RUN    = process.argv.includes('--dry-run');
export const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
export const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || '';
export const TG_ENABLED = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';

// off   → no exchange calls at all, alerts only (default-safe if unset)
// paper → logs what would have traded, no exchange calls
// live  → places real MEXC orders — requires MEXC_API_KEY/MEXC_API_SECRET
export const MEXC_API_KEY    = process.env.MEXC_API_KEY    || '';
export const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';
export const TRADE_MODE      = (process.env.TRADE_MODE || 'paper').toLowerCase();
export const TRADE_USD_SIZE  = parseFloat(process.env.TRADE_USD_SIZE || '25');
export const TRADE_MAX_LIVE  = parseInt(process.env.TRADE_MAX_CONCURRENT_LIVE || '1');

// ── Percentage-based order sizing ──
// 'usd'     → fixed-dollar sizing (TRADE_USD_SIZE), original behavior
// 'percent' → TRADE_SIZE_PCT% of available balance is allocated each cycle
//             (100% = full balance; split equally across picks in topN mode),
//             so a profitable close compounds into a bigger next buy.
//   - live mode  → available balance = real MEXC USDT free balance (fetched
//     fresh each cycle via mexcFreeBalance — automatically reflects gains).
//   - paper mode → no real balance exists, so a virtual balance is tracked
//     in paper-balance.json, seeded from PAPER_STARTING_BALANCE, debited on
//     paper buy and credited back (qty × exitPrice) on paper close.
export const TRADE_SIZE_MODE          = (process.env.TRADE_SIZE_MODE || 'usd').toLowerCase();
export const TRADE_SIZE_PCT           = parseFloat(process.env.TRADE_SIZE_PCT || '100');
export const PAPER_STARTING_BALANCE   = parseFloat(process.env.PAPER_STARTING_BALANCE || '1000');

// ── How long terminal positions stay in positions.json before removal ──
export const TERMINAL_EVICT_MS = {
  stopped:  5  * 60 * 1000,   //  5 min
  tp2_hit:  8  * 60 * 1000,   //  8 min
  tp1_hit:  5  * 60 * 1000,   //  5 min — now a full sell at T1, slot freed immediately
  exiting:  10 * 60 * 1000,   // 10 min
};

export const SKIP_SETUPS = new Set(['SHORT SETUP']);

// ── Shared price-decimal-places helper ──────────────────────────────────
// Previously duplicated independently in leaderboard-decider.js,
// alert-runner.js, and position-monitor.js, each with its OWN tier
// boundaries that drifted out of sync with each other over time.
// leaderboard-decider.js's copy — the one that actually sets entryPrice/
// stop/t1/t2 on the position at buy time — used only `p < 10 ? 4 : 2`,
// which is far too coarse for sub-$1 tokens (GALA, SHIB-style prices):
// entry and a 1.5%-away stop both round to the SAME 4-decimal value,
// collapsing the intended stop distance to zero and causing an
// essentially-instant stop-out on ordinary noise, not a real reversal.
// One shared function, imported everywhere, so a coin's rounding
// precision can't silently differ between the code that OPENS a
// position and the code that MONITORS it.
export function priceDecimals(p) {
  if (p < 0.01) return 6;
  if (p < 1)    return 4;
  if (p < 100)  return 3;
  return 2;
}

// ── Generic I/O helpers ──
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, o)  { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

export const loadMarketData = () => loadJSON(MARKET_DATA_PATH, { fetchedAt: 0, symbols: {} });
export const saveMarketData = d  => saveJSON(MARKET_DATA_PATH, d);

// market-state.json — Market Intelligence Engine output (v15 design doc).
// Written by market-fetcher.js each Job A cycle; read-only here. Never
// falls back silently to a stale/empty object without callers being able
// to tell — btcRiskScore:null / symbols:{} signals "not computed yet".
export const loadMarketState = () => loadJSON(MARKET_STATE_PATH, {
  fetchedAt: 0, btcRiskScore: null, btcRiskBand: 'UNKNOWN', btcRiskAction: 'watch',
  marketRegime: 'NEUTRAL', breadth: { score: null, bullCount: 0, total: 0 },
  breadthMomentum: { delta: 0, trend: 'FLAT' },
  buyStatus: { status: 'UNKNOWN', canBuyNormally: false, reason: 'Market state not ready yet', btcRiskGate: 'UNKNOWN', breadthGate: 'UNKNOWN' },
  symbols: {},
});
export const loadPositions  = () => loadJSON(POSITIONS_PATH, {});
export const savePositions  = p  => saveJSON(POSITIONS_PATH, p);
export const loadAlertState = () => loadJSON(LB_ALERT_STATE_PATH, {});
export const saveAlertState = s  => saveJSON(LB_ALERT_STATE_PATH, s);
export const loadCooldowns  = () => loadJSON(COOLDOWN_STATE_PATH, {});
export const saveCooldowns  = s  => saveJSON(COOLDOWN_STATE_PATH, s);
export const loadCvdState   = () => loadJSON(CVD_STATE_PATH, {});
export const saveCvdState   = s  => saveJSON(CVD_STATE_PATH, s);
export const loadHistory    = () => loadJSON(SYMBOL_HISTORY_PATH, []);
export const saveHistory    = h  => fs.writeFileSync(SYMBOL_HISTORY_PATH, JSON.stringify(h)); // compact — it's log data, not something you hand-edit

export const loadTradeState = () => loadJSON(TRADE_STATE_PATH, { tradingEnabled: true, lastUpdateId: 0, changedAt: 0 });
export const saveTradeState = s  => saveJSON(TRADE_STATE_PATH, s);

// ── Virtual paper-trading balance (only used when TRADE_SIZE_MODE=percent) ──
// Real balance isn't available in paper mode (no exchange account involved),
// so this file stands in for it: seeded once from PAPER_STARTING_BALANCE,
// then debited on every paper buy and credited back (qty × exit price) on
// every paper close — so percentage sizing compounds in paper mode the same
// way it will once you're live and pulling the real MEXC USDT balance.
export const loadPaperBalance = () => loadJSON(PAPER_BALANCE_PATH, { balance: PAPER_STARTING_BALANCE, updatedAt: 0 }).balance;
export function adjustPaperBalance(delta) {
  const state = loadJSON(PAPER_BALANCE_PATH, { balance: PAPER_STARTING_BALANCE, updatedAt: 0 });
  state.balance   = Math.max(0, parseFloat((state.balance + delta).toFixed(2)));
  state.updatedAt = Date.now();
  saveJSON(PAPER_BALANCE_PATH, state);
  return state.balance;
}

// ── Generic repeat-alert cooldown ─────────────────────────────────────────
// Originally built for MEXC balance-fetch failures (an expired/invalid API
// key silently degrading rotation/adoption with only a console.log — no
// Telegram alert at all, unlike the buy/sell paths). Kept generic so it can
// be reused for anything else that would otherwise re-alert every single
// 5-10 min cycle while a condition persists (e.g. "exit signal hit but
// TRADE_MODE isn't live" below) — one immediate alert, then a periodic
// reminder rather than a flood.
//
// shouldAlertOnce(source) decides whether THIS occurrence should actually
// send a Telegram alert:
//   - Always true the first time a given `source` starts firing.
//   - Then suppressed (returns false) for ALERT_COOLDOWN_MIN while it keeps
//     firing.
//   - Automatically resets once the underlying condition clears (call
//     clearAlertCooldown(source)), so recovery needs no manual cleanup and
//     a NEW occurrence later starts a fresh "alert immediately" cycle.
const ALERT_COOLDOWN_MIN = parseFloat(process.env.ALERT_COOLDOWN_MIN || '60');
export function shouldAlertOnce(source) {
  const state = loadJSON(MEXC_AUTH_ALERT_PATH, {});
  const now = Date.now();
  const last = state[source];
  const shouldAlert = !last || (now - last) / 60000 >= ALERT_COOLDOWN_MIN;
  if (shouldAlert) {
    state[source] = now;
    saveJSON(MEXC_AUTH_ALERT_PATH, state);
  }
  return shouldAlert;
}
export function clearAlertCooldown(source) {
  const state = loadJSON(MEXC_AUTH_ALERT_PATH, {});
  if (state[source]) {
    delete state[source];
    saveJSON(MEXC_AUTH_ALERT_PATH, state);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// trade-log.json — PERMANENT record of every API buy/sell placed by the
// MEXC auto-trader (paper or live). Unlike positions.json, entries here are
// never evicted — this is the durable audit trail the GUI "API Trades" panel
// should read for full history, since positions.json only keeps a position
// around for 5-20 min after it closes (TERMINAL_EVICT_MS) before deleting it.
// ══════════════════════════════════════════════════════════════════════════════
export const loadTradeLog = () => loadJSON(TRADE_LOG_PATH, []);
export const saveTradeLog = t  => saveJSON(TRADE_LOG_PATH, t);

// Called the moment a buy (paper or live) is placed.
export function recordTradeOpen(pos, { mode, orderId, qty, fillPrice, usdSize }) {
  const log = loadTradeLog();
  log.push({
    id:          `${pos.sym}_${orderId}`,
    sym:         pos.sym,
    base:        pos.base,
    assetType:   pos.assetType,
    setup:       pos.setup,
    mode,
    status:      'open',
    buyAt:       Date.now(),
    buyOrderId:  orderId,
    buyQty:      qty,
    buyPrice:    fillPrice,
    usdSize,
    sellAt:      null,
    sellOrderId: null,
    sellQty:     null,
    sellPrice:   null,
    reason:      null,
    pnlPct:      null,
  });
  saveTradeLog(log);
  return log;
}

// ── Dedupe guard for MANUAL_ADOPTED re-adoption ──────────────────────────
// Second line of defense behind the positions.json push-retry above: even
// with that fixed, adoptManualHoldings() shouldn't blindly trust an empty/
// stale local positions.json is the truth. Before logging a fresh
// MANUAL_ADOPTED trade-log row, check whether the PERMANENT trade log
// (never evicted, unlike positions.json) already has an 'open' row for
// this exact symbol+mode — if so, this is almost certainly the same
// still-open holding being re-seen after a lost write, not a new buy, and
// logging it again would just duplicate the row in the GUI's API Trades
// panel and pollute the win-rate/PnL totals.
export function hasOpenTradeLogEntry(sym, mode) {
  const log = loadTradeLog();
  return log.some(t => t.sym === sym && t.mode === mode && t.status === 'open');
}

// Called when Position Intelligence auto-executes a REDUCE_25/REDUCE_50
// partial sell. Unlike recordTradeClose (which closes the ORIGINAL open
// row and is meant to be called exactly once per position), this APPENDS a
// new row representing just the slice sold — the original open row is left
// untouched, still representing the position's full original entry.
// closeLiveOrder()'s eventual full close later still works correctly off
// the real remaining exchange balance at that time, independent of what's
// recorded here — this function exists purely so the permanent trade-log /
// API Trades panel shows each partial reduction as its own visible row,
// instead of the partial silently vanishing into the final close's numbers.
export function recordTradePartialExit(pos, reason, sell = {}) {
  const log = loadTradeLog();
  const orderId = pos.liveOrder?.buyOrderId;
  log.push({
    id:          `${pos.sym}_${orderId}_partial_${Date.now()}`,
    sym:         pos.sym,
    base:        pos.base,
    assetType:   pos.assetType,
    setup:       pos.setup,
    mode:        pos.liveOrder?.mode,
    status:      'closed',
    partial:     true,
    buyAt:       pos.liveOrder?.buyAt || null,
    buyOrderId:  orderId,
    buyQty:      sell.qty,
    buyPrice:    pos.entryPrice,
    usdSize:     sell.qty * pos.entryPrice,
    sellAt:      Date.now(),
    sellOrderId: sell.orderId || null,
    sellQty:     sell.qty,
    sellPrice:   sell.fillPrice ?? null,
    reason,
    pnlPct: (pos.entryPrice && sell.fillPrice)
      ? parseFloat(((sell.fillPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2))
      : null,
  });
  saveTradeLog(log);
  return log;
}

// Called the moment a position closes (stop/T1/T2/exit/rotation), for both
// paper and live trades. Matches the open entry by buyOrderId, falling back
// to the most recent still-open entry for the same symbol.
export function recordTradeClose(pos, reason, sell = {}) {
  const log      = loadTradeLog();
  const orderId  = pos.liveOrder?.buyOrderId;
  let   entry    = log.find(t => t.status === 'open' && t.buyOrderId === orderId);
  if (!entry) {
    entry = [...log].reverse().find(t => t.status === 'open' && t.sym === pos.sym);
  }
  if (!entry) return log; // no matching open trade — nothing to record

  entry.status      = 'closed';
  entry.sellAt      = Date.now();
  entry.sellOrderId = sell.orderId || null;
  entry.sellQty     = sell.qty ?? entry.buyQty;
  entry.sellPrice   = sell.fillPrice ?? null;
  entry.reason      = reason;
  entry.pnlPct      = (entry.buyPrice && entry.sellPrice)
    ? parseFloat(((entry.sellPrice - entry.buyPrice) / entry.buyPrice * 100).toFixed(2))
    : null;

  saveTradeLog(log);
  return log;
}

// ── Shared GitHub Contents API push, with 409-conflict retry ───────────────
// Every state file pushed to GitHub (positions/trade-log/audit/heartbeat/
// live-balances) can lose a race against another concurrent job run — decide
// runs every ~5 min (fetch every 5 min, decide 2 min after each fetch), tight
// enough for a scheduled run and a Cloudflare Worker-dispatched run to land
// close together (see pushHeartbeatToGitHub's original note on this exact
// race). A losing PUT gets back 409 (sha mismatch); without a retry that
// write is silently dropped — logged only as a console warning — and
// whatever state it represented never lands. For positions.json specifically,
// a dropped write is how a manual-holding adoption gets "forgotten": the
// next run's checkout still shows the coin as untracked, so
// adoptManualHoldings() re-adopts it and logs a second "MANUAL POSITION
// ADOPTED" trade-log row for a balance that was only ever bought once.
//
// One retry against a freshly refetched sha resolves the vast majority of
// races — a second overlap in the same few-hundred-ms window is rare enough
// not to need more than one retry (matches the original heartbeat pattern
// this was extracted from).
async function putGitHubContent(apiUrl, headers, branch, body) {
  const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.ok) body.sha = (await getRes.json()).sha || undefined;
  else if (getRes.status !== 404) throw new Error(`GET ${getRes.status}`);

  let putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });

  if (!putRes.ok && putRes.status === 409) {
    const getRes2 = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes2.ok) {
      body.sha = (await getRes2.json()).sha || undefined;
      putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    }
  }

  if (!putRes.ok) {
    const e = await putRes.json().catch(() => ({}));
    throw new Error(`PUT ${putRes.status} ${e.message || ''}`);
  }
  return putRes;
}

// ── Push trade-log.json to GitHub so the GUI's API Trades panel can read
// the full permanent history (same pattern as pushPositionsToGitHub) ──
export async function pushTradeLogToGitHub(tradeLog) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH         || 'main';
  const fpath  = process.env.GH_TRADE_LOG_PATH || 'scripts/trade-log.json';

  if (!token || !repo) {
    console.log('[trade-log-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    await putGitHubContent(apiUrl, headers, branch, {
      message: `chore: trade log update (${tradeLog.length} trades) [skip ci]`,
      content: Buffer.from(JSON.stringify(tradeLog, null, 2)).toString('base64'),
      branch,
    });
    console.log(`[trade-log-push] ✓ ${tradeLog.length} trade(s) on record`);
    logAudit('trade_log_pushed', { count: tradeLog.length });
  } catch (e) {
    console.warn(`[trade-log-push] ⚠ ${e.message}`);
    logAudit('trade_log_push_failed', { error: e.message });
  }
}

// ── Audit ──
// Kept as a count-based cap rather than a time window — a 1-hour window
// used to mean almost nothing survived between 15-min cron runs' worth of
// useful history. 3000 entries is roughly several days of activity at
// typical per-cycle volume, which is what the GUI's API Audit tab needs to
// show something meaningful rather than just the last run or two.
const AUDIT_MAX_ROWS = 3000;

export function logAudit(action, details = {}) {
  const entry = { timestamp: new Date().toISOString(), job: 'leaderboard-decider', action, ...details };
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); if (!Array.isArray(logs)) logs = []; } catch {}
  logs.push(entry);
  if (logs.length > AUDIT_MAX_ROWS) logs = logs.slice(logs.length - AUDIT_MAX_ROWS);
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
}

export function loadAuditLog() {
  try { const logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); return Array.isArray(logs) ? logs : []; }
  catch { return []; }
}

// ── Push audit.json to GitHub so the GUI's new "API Audit" tab can read
// every API/trade action the headless job has taken (same pattern as
// pushPositionsToGitHub/pushTradeLogToGitHub) ──
export async function pushAuditLogToGitHub(logs) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_AUDIT_PATH    || 'scripts/audit-log.json';

  if (!token || !repo) {
    console.log('[audit-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    await putGitHubContent(apiUrl, headers, branch, {
      message: `chore: audit log update (${logs.length} entries) [skip ci]`,
      content: Buffer.from(JSON.stringify(logs, null, 2)).toString('base64'),
      branch,
    });
    console.log(`[audit-push] ✓ ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'} pushed`);
  } catch (e) {
    // Deliberately NOT calling logAudit here — a failure to push the audit
    // log logging itself would just grow the very file that failed to push.
    console.warn(`[audit-push] ⚠ ${e.message}`);
  }
}

// ── Push a snapshot of real MEXC account balances to GitHub, so the GUI's
// Trade Journal can cross-check whether a row it thinks is still "open"
// actually still has a matching balance on the exchange — catches drift from
// manual trading, missed sells, etc. that positions.json/trade-log.json
// alone wouldn't reveal. Live mode only; paper mode has no real balance. ──
export async function pushLiveBalancesToGitHub(balances) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH             || 'main';
  const fpath  = process.env.GH_LIVE_BALANCES_PATH || 'scripts/mexc-live-balances.json';

  if (!token || !repo) {
    console.log('[live-balances-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const snapshot = { fetchedAt: new Date().toISOString(), balances };
  const apiUrl   = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers  = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    await putGitHubContent(apiUrl, headers, branch, {
      message: `chore: live balances snapshot (${balances.length} asset(s)) [skip ci]`,
      content: Buffer.from(JSON.stringify(snapshot, null, 2)).toString('base64'),
      branch,
    });
    console.log(`[live-balances-push] ✓ ${balances.length} asset(s) pushed`);
    logAudit('live_balances_pushed', { count: balances.length });
  } catch (e) {
    console.warn(`[live-balances-push] ⚠ ${e.message}`);
    logAudit('live_balances_push_failed', { error: e.message });
  }
}

// ── Push positions.json to GitHub so the browser GUI stays in sync ──
export async function pushPositionsToGitHub(positions) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_POSITIONS_PATH || 'scripts/positions.json';

  if (!token || !repo) {
    console.log('[positions-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    await putGitHubContent(apiUrl, headers, branch, {
      message: `chore: positions update (${Object.keys(positions).length} open) [skip ci]`,
      content: Buffer.from(JSON.stringify(positions, null, 2)).toString('base64'),
      branch,
    });
    console.log(`[positions-push] ✓ ${Object.keys(positions).length} position(s) pushed`);
    logAudit('positions_pushed', { count: Object.keys(positions).length });
  } catch (e) {
    console.warn(`[positions-push] ⚠ ${e.message}`);
    logAudit('positions_push_failed', { error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// heartbeat.json — records the timestamp of the last successful job completion.
// Committed to the repo (same round-trip pattern as positions.json) so it
// persists across GitHub Actions runs, which otherwise have no memory of
// their own between invocations.
//
// Purpose: the decide job is now driven entirely by a Cloudflare Worker —
// no native GitHub cron fallback — firing fetch every 5 min and decide 2
// min after each fetch, so decide's own cadence is effectively every 5
// min too. (Previously this was ~17 min under native cron with the Worker
// as a safety net; that native path is now fully disabled.) Cloudflare
// Workers and cron triggers can both silently stall or get skipped —
// there's no notification for that on either side. Checking "how long
// since the last successful run" at the START of every run is how the bot
// notices a gap itself, rather than someone discovering it retroactively by
// noticing stale prices or a position that should've rotated but didn't.
// ══════════════════════════════════════════════════════════════════════════════
export const loadHeartbeat = () => loadJSON(HEARTBEAT_PATH, { lastRunAt: 0 });

export async function pushHeartbeatToGitHub(lastRunAt) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH        || 'main';
  const fpath  = process.env.GH_HEARTBEAT_PATH || 'scripts/heartbeat.json';

  if (!token || !repo) {
    console.log('[heartbeat-push] Skipping — GITHUB_TOKEN or GH_REPO not set');
    return;
  }

  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${fpath}`;
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  };

  try {
    await putGitHubContent(apiUrl, headers, branch, {
      message: `chore: heartbeat ${new Date(lastRunAt).toISOString()} [skip ci]`,
      content: Buffer.from(JSON.stringify({ lastRunAt }, null, 2)).toString('base64'),
      branch,
    });
    console.log(`[heartbeat-push] ✓ recorded ${new Date(lastRunAt).toISOString()}`);
  } catch (e) {
    console.warn(`[heartbeat-push] ⚠ ${e.message}`);
    logAudit('heartbeat_push_failed', { error: e.message });
  }
}

// Returns { stale, gapMinutes, lastRunAt } — checked at job start, BEFORE
// this run's own heartbeat gets written, so it reflects the gap since the
// PREVIOUS successful completion. lastRunAt === 0 (first run ever, or file
// missing) is never reported as stale — nothing to compare against yet.
export function checkHeartbeatStale(expectedIntervalMin = 5, thresholdMultiplier = 2.5) {
  const { lastRunAt } = loadHeartbeat();
  if (!lastRunAt) return { stale: false, gapMinutes: 0, lastRunAt: 0 };
  const gapMinutes = (Date.now() - lastRunAt) / 60000;
  const stale = gapMinutes > expectedIntervalMin * thresholdMultiplier;
  return { stale, gapMinutes: parseFloat(gapMinutes.toFixed(1)), lastRunAt };
}

