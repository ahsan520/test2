// ══════════════════════════════════════════════════════════════════════════════
// position-monitor.js — Job B position lifecycle management
//
// Runs every Job B cycle BEFORE the buy signal scan. For every open position
// in positions.json it:
//   1. Reads live price from market-data.json
//   2. Checks stop / T1 / T2 (price-based, immediate)
//   3. Computes exit score (CVD + OI + FR + RSI) → marks 'exiting'
//   4. Removes positions that have been in terminal state long enough
//   5. Removes positions that have been 'watching' past LB_STALE_WATCH_HRS
//
// This means positions.json is always up to date even when the browser is
// never opened. Telegram alerts fire for every status change (caller sends
// the returned telegramAlerts[] — this module never calls sendTelegram
// directly, so it stays decoupled from the Telegram layer).
// ══════════════════════════════════════════════════════════════════════════════

import { mexcMarketSell, mexcFreeBalance, mexcGetAllBalances, getBaseSizePrecision, floorToStep, mexcGetOrderStatus, mexcCancelOrder } from './mexc-client.js';
import {
  logAudit, loadCvdState, saveCvdState, TERMINAL_EVICT_MS, MEXC_API_KEY, MEXC_API_SECRET,
  loadTradeLog, recordTradeClose, recordTradePartialExit, pushTradeLogToGitHub,
  TRADE_SIZE_MODE, adjustPaperBalance, priceDecimals,
  shouldAlertOnce, clearAlertCooldown,
} from './job-state.js';
import { calcConviction } from './leaderboard-scanner.js';
import { evaluatePosition, positionIntelligenceEnabled } from './position-intelligence.js';
import { evaluateProfitProtection, profitIntelligenceEnabled } from './profit-intelligence.js';

const LB_STALE_WATCH_HRS = parseFloat(process.env.LB_STALE_WATCH_HRS || '24');
// Separate, much shorter threshold for LIVE positions specifically — the
// old single 24h threshold applied to everything ('watching' status
// covers both watchlist-only signals AND live MEXC positions, since
// status doesn't change on fill). For a watchlist-only signal that's
// fine — nothing real to sell, just stop tracking. For a LIVE position,
// 24h is far too long to leave real capital sitting stagnant, AND —
// separately, this was the actual bug — the eviction below never sold
// the position, just deleted the tracking record, silently abandoning a
// real open MEXC position with no further stop-loss protection at all.
const LB_STALE_LIVE_HRS  = parseFloat(process.env.LB_STALE_LIVE_HRS  || '3');
// Consecutive stale-close cycles a position must read zero exchange balance
// before this path force-closes tracking itself, instead of retrying (and
// re-alerting) forever. Mirrors reconcileTrackedLiveBalances' own
// STRIKE_LIMIT — kept as a separate constant/counter (staleZeroBalanceStrikes,
// not zeroBalanceStrikes) since the two checks run independently and
// shouldn't reset each other's progress.
const STALE_ZERO_BALANCE_STRIKE_LIMIT = parseInt(process.env.LB_STALE_ZERO_BALANCE_STRIKES || '2');
// ── Sell Intelligence age gate (dev-team "Buy Priority / Rotation / Sell
// Intelligence" doc): "Normal Sell Intelligence can act after 5 minutes;
// hard stop is never blocked by age." SELL_MIN_POSITION_AGE_MIN is the
// dedicated var for that — falls back to LB_HOLD_LOCK if unset, so an
// existing repo Variable for LB_HOLD_LOCK keeps working exactly as before.
// This only ever gates section 5b/5c/6 below (Position Intelligence,
// Profit Intelligence, CVD/OI/FR/RSI exit score) — section 4
// (price-based stop/T1/T2 exits) runs BEFORE this gate and is never
// delayed by it, matching "hard stop is never blocked by age" exactly.
const SELL_MIN_POSITION_AGE_MIN = parseInt(process.env.SELL_MIN_POSITION_AGE_MIN || process.env.LB_HOLD_LOCK || '5');
const LB_EXIT_CVD_CYCLES = parseInt(process.env.LB_EXIT_CVD_CYCLES || '3');
const LB_EXIT_SCORE_MIN  = parseInt(process.env.LB_EXIT_SCORE_MIN  || '3');

// Positions worth less than this on the exchange can't be sold at all —
// MEXC rejects orders under ~$1 USDT notional. Below this, closeLiveOrder
// skips the sell attempt entirely and closes the position out of tracking
// as dust instead of retrying (and re-alerting) the same failed order every
// cycle forever. Set via repo Variable MEXC_MIN_SELL_NOTIONAL_USDT.
const MIN_SELL_NOTIONAL_USDT = parseFloat(process.env.MEXC_MIN_SELL_NOTIONAL_USDT || '5');
const QUOTE_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'DAI', 'FDUSD']);

// Position Intelligence's REDUCE_25/REDUCE_50 actions are recommend-only
// until this is explicitly turned on — off by default so the newly-built
// partial-sell execution path (closeLiveOrderPartial below) isn't live on
// a real account the first time it's exercised. Flip to 'true' once you've
// watched it fire correctly in paper mode a few times.
const AUTO_PARTIAL_EXIT = (process.env.SELL_AUTO_PARTIAL_EXIT || 'false') === 'true';

// ══════════════════════════════════════════════════════════════════════════════
// reconcileTrackedLiveBalances — runs EVERY live cycle, independent of rotation.
//
// Previously, checking a tracked position's real MEXC balance only happened
// (a) when its own stop/T1/T2 triggered a sell attempt, or (b) inside
// executeRotation, which itself only runs when a new pick qualifies to
// rotate into this cycle. A position that was sold manually (outside the
// bot) but whose price never happened to cross its tracked stop/target, and
// no new rotation-worthy signal came along, would sit "open" in
// positions.json indefinitely — undetected, and blocking that symbol from
// ever being re-alerted (STEP 2's "already open" check doesn't know the
// difference).
//
// This closes that gap: every live cycle, check every tracked live
// position's REAL exchange balance directly, independent of price action
// or rotation. If the real balance has genuinely dropped to ~0 (not just
// locked in another order), close the tracking entry out rather than
// leaving it to loop forever.
//
// Uses a strike counter rather than closing on the very first zero read —
// a fresh buy's balance can occasionally lag the exchange's own account
// endpoint by a few seconds, and this avoids closing out a real position
// on that kind of transient blip.
// ══════════════════════════════════════════════════════════════════════════════
export async function reconcileTrackedLiveBalances(positions, effectiveTradeMode, utc) {
  const telegramAlerts = [];
  if (effectiveTradeMode !== 'live') return { changed: false, telegramAlerts };

  const tracked = Object.entries(positions).filter(
    ([, p]) => p.assetType === 'crypto'
      && p.liveOrder?.mode === 'live'
      && !p.liveOrder?.closedAt
      && !['stopped', 'tp2_hit'].includes(p.status)
  );
  if (!tracked.length) return { changed: false, telegramAlerts };

  let balances = [];
  try {
    balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
    clearAlertCooldown('reconcile_balances');
  } catch (e) {
    console.log(`  ⚠️  Balance reconcile: couldn't fetch MEXC balances (${e.message}) — skipping this cycle`);
    if (shouldAlertOnce('reconcile_balances')) {
      telegramAlerts.push(
        `🚨 *MEXC API ERROR — Balance Reconcile* \n  Couldn't fetch account balances: ${e.message}\n` +
        `  _Manual-sell detection is skipped this cycle (won't affect the price-based stop/T1/T2 checks, which use market price, not balance) — check your MEXC API key hasn't expired or been revoked. Further repeats of this suppressed for ${process.env.ALERT_COOLDOWN_MIN || '60'} min._`
      );
    }
    return { changed: false, telegramAlerts };
  }
  const freeByBase = new Map(balances.map(b => [b.asset, b.free]));

  let changed = false;
  const STRIKE_LIMIT = 2; // require 2 consecutive zero-reads before treating as a real manual sell

  for (const [key, pos] of tracked) {
    if (QUOTE_ASSETS.has(pos.base)) continue;
    const free = freeByBase.get(pos.base) || 0;

    // Real balance significantly EXCEEDS tracked qty — the opposite problem
    // from a manual sell. Most likely cause: a manual re-buy landed on a
    // symbol that already had a tracked (possibly near-zero/dust) entry, so
    // adoptManualHoldings never touched it (it only adopts symbols with NO
    // existing entry at all). Left uncorrected, sell sizing elsewhere
    // (closeLiveOrder) and dust checks (countLiveOpenPositions) keep working
    // from the stale, understated tracked qty/usdSize indefinitely — this
    // self-heals those fields to match the real exchange balance.
    const trackedQty = pos.liveOrder.qty || 0;
    if (free > trackedQty * 1.5 && free - trackedQty > 0.000001) {
      const refPrice = pos.entryPrice || pos.liveOrder.fillPrice || 0;
      const oldQty = trackedQty;
      pos.liveOrder.qty     = free;
      pos.liveOrder.usdSize = refPrice > 0 ? parseFloat((free * refPrice).toFixed(2)) : pos.liveOrder.usdSize;
      changed = true;
      logAudit('position_qty_reconciled_up', { sym: key, base: pos.base, oldQty, newQty: free });
      telegramAlerts.push(
        `🔧 *TRACKING CORRECTED* — ${pos.base}\n` +
        `  Tracked qty was ${oldQty}, real MEXC balance is ${free} — updated to match. This position was undersized in tracking, likely from an earlier manual buy the bot didn't fully reconcile.`
      );
    }

    // Real balance still present (even partially) — reset strikes, nothing to do.
    if (free > 0) {
      if (pos.liveOrder.zeroBalanceStrikes) pos.liveOrder.zeroBalanceStrikes = 0;
      continue;
    }

    pos.liveOrder.zeroBalanceStrikes = (pos.liveOrder.zeroBalanceStrikes || 0) + 1;
    if (pos.liveOrder.zeroBalanceStrikes < STRIKE_LIMIT) {
      console.log(`  ⚠️  ${pos.base} — exchange balance reads 0 (strike ${pos.liveOrder.zeroBalanceStrikes}/${STRIKE_LIMIT}), rechecking next cycle`);
      continue;
    }

    // Confirmed gone — close it out rather than looping forever.
    pos.status = 'stopped';
    pos.liveOrder.closedAt      = Date.now();
    pos.liveOrder.exitFillPrice = pos.liveOrder.fillPrice; // real exit price unknown — this was NOT a bot-tracked sell
    recordTradeClose(pos, 'manual_sell_detected_zero_balance', { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
    changed = true;
    logAudit('position_manual_sell_detected', { sym: key, base: pos.base });
    telegramAlerts.push(
      `🔍 *MANUAL SELL DETECTED* — ${pos.base}\n` +
      `  Exchange balance reads 0 across 2 checks — closing tracking (assumed sold outside the bot).\n` +
      `  _Real exit price unknown — P&L recorded using last known fill price, not your actual sale price._  ${utc || ''}`
    );
  }

  return { changed, telegramAlerts };
}

// A position too small to even sell (see MIN_SELL_NOTIONAL_USDT above)
// shouldn't occupy a TRADE_MAX_CONCURRENT_LIVE slot either — otherwise a
// leftover $0.01 dust fragment silently blocks every future real buy
// forever, with no way to "close" something that can't be sold. Same
// notional definition of "dust" used here as in closeLiveOrder below.
function currentNotional(p) {
  const usd = p.liveOrder?.usdSize;
  if (usd && usd > 0) return usd;
  // usdSize can be 0/missing on some adopted positions — fall back to
  // qty × fill price so a $0-usdSize-but-real-qty position isn't
  // miscounted as dust.
  return (p.liveOrder?.qty || 0) * (p.liveOrder?.fillPrice || 0);
}

export function countLiveOpenPositions(positions) {
  return Object.values(positions).filter(
    p => p.liveOrder?.mode === 'live'
      && !p.liveOrder?.closedAt
      && !['stopped', 'tp1_hit', 'tp2_hit'].includes(p.status)
      && currentNotional(p) >= MIN_SELL_NOTIONAL_USDT
  ).length;
}

// ── Closes a live MEXC position when a stop or T2 fires headlessly ──
// Re-checks actual exchange balance before selling (never trusts the
// locally-tracked qty alone — fees or manual intervention could have
// changed it) and floors to the exchange's lot-size step so the order
// isn't rejected for too many decimals.
// Returns { closed, reason } so callers know whether the exchange position
// was ACTUALLY closed before they mark the local position record terminal.
// reason ∈ 'already_closed' | 'noncrypto' | 'paper' | 'sold' | 'zero_balance' | 'error'
export async function closeLiveOrder(pos, reason, telegramAlerts, effectiveTradeMode = 'live') {
  if (!pos.liveOrder || pos.liveOrder.closedAt) return { closed: false, reason: 'already_closed' };

  // ── TRADE_MODE has moved off 'live' since this position was opened ──
  // A position's liveOrder.mode is stamped once, at buy time, and never
  // retroactively changes — correctly so, since it reflects a real coin
  // balance that actually exists on the exchange. But TRADE_MODE switching
  // to paper/off afterward is a deliberate signal to stop the BOT from
  // acting with real money — it shouldn't keep placing real sell orders
  // just because a stop/T1/T2/profit-protection condition fires. Leave the
  // position completely untouched (no closedAt, still tracked) so a human
  // can decide, or flip TRADE_MODE back to live to resume automatic exits.
  // NOTE: this only applies to the periodic monitorPositions() checks —
  // rotation and the BTC-panic emergency-close already only ever touch
  // positions whose liveOrder.mode matches the CURRENT effectiveTradeMode
  // (see their own filters), so they're unaffected by this.
  if (pos.liveOrder.mode === 'live' && effectiveTradeMode !== 'live') {
    if (shouldAlertOnce(`trade_mode_paused:${pos.base}`)) {
      telegramAlerts.push(
        `⏸️ *EXIT PAUSED — TRADE_MODE=${effectiveTradeMode}* — ${pos.base}\n` +
        `  Exit condition hit (${reason}) but TRADE\\_MODE is no longer live — leaving your real ${pos.base} position open and unmanaged by the bot.\n` +
        `  _Flip TRADE\\_MODE back to live to resume automatic exits, or close manually on MEXC. Further repeats of this suppressed for ${process.env.ALERT_COOLDOWN_MIN || '60'} min._`
      );
    }
    logAudit('mexc_sell_paused_trade_mode', { sym: pos.base + 'USDT', reason, effectiveTradeMode });
    return { closed: false, reason: 'trade_mode_paused' };
  }

  // MEXC is crypto-only — never attempt an exchange call for stocks/ETFs.
  // This shouldn't happen (buy-side already filters assetType === 'crypto')
  // but acts as a hard safety net in case a non-crypto position ever
  // acquires a liveOrder through a future code path.
  if (pos.assetType && pos.assetType !== 'crypto') {
    console.log(`  ⚠  closeLiveOrder skipped — ${pos.base} is assetType:${pos.assetType}, MEXC is crypto-only`);
    logAudit('mexc_sell_skipped_noncrypto', { base: pos.base, assetType: pos.assetType, reason });
    return { closed: false, reason: 'noncrypto' };
  }

  // Paper trades never touch the exchange — just record the close using the
  // exit price the caller already computed (pos.exitPrice), so the permanent
  // trade log has a full paper buy/sell record too, not just live ones.
  if (pos.liveOrder.mode !== 'live') {
    pos.liveOrder.closedAt      = Date.now();
    pos.liveOrder.exitFillPrice = pos.exitPrice || pos.liveOrder.fillPrice;
    recordTradeClose(pos, reason, { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
    // Credit the virtual paper balance back (proceeds = qty × exit price) so
    // percentage-based sizing compounds paper gains/losses into the next buy,
    // same as a real MEXC balance would once live.
    if (TRADE_SIZE_MODE === 'percent') {
      const proceeds = pos.liveOrder.qty * pos.liveOrder.exitFillPrice;
      adjustPaperBalance(proceeds);
    }
    return { closed: true, reason: 'paper' };
  }

  const symbol = pos.base + 'USDT';

  // ── Reconcile the exchange-side stop before attempting any other sell ──
  // A live position can carry a resting STOP_LOSS_LIMIT order (see
  // mexc-trader.js placeExchangeStop). Two cases matter here:
  //   1. It already FILLED — MEXC closed the position before this check
  //      ran (this is the whole point of having it: it beats the 15-min
  //      cycle). Reconcile using that fill instead of attempting a second
  //      sell, which would fail (nothing left to sell).
  //   2. It's still resting (NEW/PARTIALLY_FILLED) — its quantity is LOCKED
  //      on the exchange, so a market sell below would fail with a false
  //      "0 balance" for T1/T2/rotation/exit-signal closes. Cancel it first
  //      to free that quantity, then fall through to the normal sell path.
  if (pos.liveOrder.stopOrderId) {
    try {
      const status = await mexcGetOrderStatus(MEXC_API_KEY, MEXC_API_SECRET, symbol, pos.liveOrder.stopOrderId);
      if (status.status === 'FILLED') {
        const qty  = parseFloat(status.executedQty || '0');
        const fill = qty > 0 ? parseFloat(status.cummulativeQuoteQty || '0') / qty : pos.exitPrice || pos.liveOrder.fillPrice;
        pos.liveOrder.sellOrderId   = pos.liveOrder.stopOrderId;
        pos.liveOrder.exitFillPrice = fill;
        pos.liveOrder.closedAt      = Date.now();
        telegramAlerts.push(`🔴 *EXCHANGE STOP FILLED* — ${pos.base} closed via the resting MEXC stop order (ahead of this ${reason} check) @ $${fill.toFixed(6)}`);
        logAudit('mexc_stop_reconciled_filled', { sym: symbol, qty, fillPrice: fill, orderId: pos.liveOrder.stopOrderId });
        recordTradeClose(pos, 'exchange_stop_fill', { orderId: pos.liveOrder.stopOrderId, qty, fillPrice: fill });
        await pushTradeLogToGitHub(loadTradeLog());
        return { closed: true, reason: 'sold' };
      }
      if (status.status === 'NEW' || status.status === 'PARTIALLY_FILLED') {
        await mexcCancelOrder(MEXC_API_KEY, MEXC_API_SECRET, symbol, pos.liveOrder.stopOrderId);
        logAudit('mexc_stop_cancelled', { sym: symbol, orderId: pos.liveOrder.stopOrderId, forReason: reason });
      }
      // Any other terminal status (CANCELED/EXPIRED/etc.) — nothing to do,
      // fall through to the normal sell path below.
    } catch (e) {
      // Order may already be gone (cancelled elsewhere, or the exchange is
      // just erroring on the lookup) — log and continue. Worst case the
      // sell below fails with zero_balance and gets the usual Telegram
      // alert + retry-next-cycle handling, same as before this change.
      logAudit('mexc_stop_reconcile_failed', { sym: symbol, orderId: pos.liveOrder.stopOrderId, error: e.message });
    }
  }

  try {
    const [step, bal] = await Promise.all([
      getBaseSizePrecision(symbol),
      mexcFreeBalance(MEXC_API_KEY, MEXC_API_SECRET, pos.base, true),
    ]);
    const free = typeof bal === 'object' ? bal.free : bal;
    const locked = typeof bal === 'object' ? bal.locked : 0;
    // Sell the REAL free balance, not Math.min(tracked qty, free) — closing
    // a position means "get rid of everything you hold of this symbol,"
    // consistent with adoptManualHoldings' own philosophy that the bot
    // manages the whole spot balance of any symbol it tracks, not a partial
    // slice. Capping at the tracked qty backfires badly whenever the real
    // balance has grown BEYOND what's tracked (e.g. a manual re-buy that
    // landed on an already-existing tracked entry, which adoptManualHoldings
    // has no path to catch since it only adopts symbols with NO existing
    // entry at all) — the old Math.min() would floor to a stale, tiny
    // tracked amount and report "zero_balance" forever while a real,
    // substantial balance sat untouched on the exchange.
    const sellQty = floorToStep(free, step);

    // ── Dust guard — checked BEFORE the zero-balance branch below ──
    // Evaluated against the REAL free balance, not sellQty. A tiny leftover
    // (e.g. 0.0057 XRP after a lot-size-step rounding remainder from an
    // earlier real sell) can floor to 0 SELLABLE units while free is still
    // technically > 0 — previously that hit the zero_balance branch first
    // and looped "kept open, retry next cycle" forever, since sellQty*price
    // is always 0 once sellQty itself is 0. Checking free*price here instead
    // catches this case and closes it out as dust, same as the existing
    // post-sell dust guard already does for a nonzero sellQty that's still
    // too small to meet MEXC's minimum notional.
    const refPrice        = parseFloat(pos.exitPrice || pos.entryPrice || 0);
    const freeEstNotional = free * refPrice;
    const DUST_EPSILON     = 1e-8; // truly-zero vs "some dust exists" cutoff
    if (free > DUST_EPSILON && refPrice > 0 && freeEstNotional < MIN_SELL_NOTIONAL_USDT) {
      pos.liveOrder.closedAt      = Date.now();
      pos.liveOrder.exitFillPrice = refPrice;
      pos.liveOrder.dustIgnored   = true;
      telegramAlerts.push(
        `🧹 *DUST IGNORED* — ${pos.base} ${reason}: ${free} ${pos.base} (~$${freeEstNotional.toFixed(4)}) remains — below MEXC's $${MIN_SELL_NOTIONAL_USDT} minimum sell (or its lot-size step) — ` +
        `leaving it on the exchange, closing out of tracking (not worth selling).`
      );
      logAudit('mexc_sell_skipped_dust', { sym: symbol, reason, free, sellQty, freeEstNotional });
      recordTradeClose(pos, `${reason} (dust — below $${MIN_SELL_NOTIONAL_USDT} min or lot step, not sold)`, { qty: free, fillPrice: refPrice });
      await pushTradeLogToGitHub(loadTradeLog());
      return { closed: true, reason: 'dust_ignored' };
    }

    if (sellQty <= 0) {
      // Give the actual locked amount too — a 0 *free* balance while coins
      // are sitting *locked* (e.g. tied up in another open order) is a very
      // different problem from truly having nothing, and this used to be
      // invisible in the alert.
      const lockedNote = locked > 0 ? ` (${locked} ${pos.base} is LOCKED in another order)` : '';
      telegramAlerts.push(`🚨 *LIVE SELL SKIPPED* — ${pos.base} ${reason} but exchange free balance reads 0${lockedNote} — check MEXC manually. Position kept open in tracking, will retry next cycle.`);
      logAudit('mexc_sell_skipped', { sym: symbol, reason, free, locked });
      return { closed: false, reason: 'zero_balance' };
    }

    const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, symbol, sellQty);
    pos.liveOrder.sellOrderId   = sell.orderId;
    pos.liveOrder.exitFillPrice = sell.fillPrice;
    pos.liveOrder.closedAt      = Date.now();
    telegramAlerts.push(`🟢 *LIVE SELL* — closed ${sellQty} ${pos.base} @ $${sell.fillPrice.toFixed(6)} on MEXC (${reason})`);
    logAudit('mexc_sell', { sym: symbol, reason, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId });
    recordTradeClose(pos, reason, { orderId: sell.orderId, qty: sellQty, fillPrice: sell.fillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
    return { closed: true, reason: 'sold' };
  } catch (e) {
    // Fallback safety net: if our pre-check above missed it (stale/missing
    // price so estNotional couldn't be computed) and MEXC itself rejects the
    // order as under its minimum, treat it the same way — close out as dust
    // instead of leaving it to fail loudly on every future cycle too.
    if (/minimum transaction volume/i.test(e.message || '')) {
      pos.liveOrder.closedAt      = Date.now();
      pos.liveOrder.exitFillPrice = parseFloat(pos.exitPrice || pos.entryPrice || 0);
      pos.liveOrder.dustIgnored   = true;
      telegramAlerts.push(`🧹 *DUST IGNORED* — ${pos.base} ${reason}: MEXC rejected the sell as below its minimum notional — leaving it on the exchange, closing out of tracking.`);
      logAudit('mexc_sell_skipped_dust', { sym: symbol, reason, error: e.message });
      recordTradeClose(pos, `${reason} (dust — MEXC min-notional rejected, not sold)`, { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
      await pushTradeLogToGitHub(loadTradeLog());
      return { closed: true, reason: 'dust_ignored' };
    }
    telegramAlerts.push(`🚨 *LIVE SELL FAILED* — ${pos.base} ${reason} but MEXC order errored: ${e.message} — CLOSE MANUALLY on the exchange. Position kept open in tracking, will retry next cycle.`);
    logAudit('mexc_sell_failed', { sym: symbol, reason, error: e.message });
    return { closed: false, reason: 'error', error: e.message };
  }
}

// ── Partial sell for Position Intelligence's REDUCE_25/REDUCE_50 ──
// Sells `pct` of whatever the position CURRENTLY holds (not a fraction of
// the original entry) — so REDUCE_25 firing once, then REDUCE_50 firing
// later as risk keeps climbing, compounds naturally (25% off, then 50% of
// what's left, ≈62.5% of the original total gone) without either action
// needing to know what the other already did. The position stays open and
// tracked afterward — the software stop / T1 / T2 checks above, and any
// later Position Intelligence EXIT/EMERGENCY_EXIT, keep working against
// whatever quantity remains, same as a manually-reduced position would.
//
// No exchange-side stop to reconcile first (see the NOTE in mexc-trader.js
// — MEXC's spot API has no stop-order type, the software check here is the
// only stop mechanism), so this is simpler than closeLiveOrder: read real
// free balance, sell pct of it, done.
//
// Returns { executed, reason, qty?, fillPrice? }. reason ∈ 'paper_partial'
// | 'sold' | 'slice_too_small' | 'remainder_would_be_dust' | 'error' |
// 'noncrypto' | 'already_closed' | 'nothing_to_sell'.
// escalateToFullClose:true on 'remainder_would_be_dust' tells the caller
// to fall through to a normal closeLiveOrder() full close instead — a
// partial that would leave an unsellable dust remainder open forever isn't
// actually safer than just closing the whole thing.
export async function closeLiveOrderPartial(pos, pct, reason, currentPrice, telegramAlerts, effectiveTradeMode = 'live') {
  if (!pos.liveOrder || pos.liveOrder.closedAt) return { executed: false, reason: 'already_closed' };
  if (pos.assetType && pos.assetType !== 'crypto') {
    logAudit('mexc_partial_sell_skipped_noncrypto', { base: pos.base, assetType: pos.assetType, reason });
    return { executed: false, reason: 'noncrypto' };
  }

  // Same TRADE_MODE-paused guard as closeLiveOrder() above — see its
  // comment for the full reasoning.
  if (pos.liveOrder.mode === 'live' && effectiveTradeMode !== 'live') {
    if (shouldAlertOnce(`trade_mode_paused:${pos.base}`)) {
      telegramAlerts.push(
        `⏸️ *EXIT PAUSED — TRADE_MODE=${effectiveTradeMode}* — ${pos.base}\n` +
        `  Partial-exit condition hit (${reason}) but TRADE\\_MODE is no longer live — leaving your real ${pos.base} position open and unmanaged by the bot.\n` +
        `  _Flip TRADE\\_MODE back to live to resume automatic exits, or manage manually on MEXC. Further repeats of this suppressed for ${process.env.ALERT_COOLDOWN_MIN || '60'} min._`
      );
    }
    logAudit('mexc_partial_sell_paused_trade_mode', { sym: pos.base + 'USDT', reason, effectiveTradeMode });
    return { executed: false, reason: 'trade_mode_paused' };
  }

  // Paper: reduce tracked qty locally, credit partial proceeds, record a
  // partial trade-log row. No exchange call.
  if (pos.liveOrder.mode !== 'live') {
    const totalQty = pos.liveOrder.qty || 0;
    const sellQty  = parseFloat((totalQty * pct).toFixed(8));
    if (sellQty <= 0) return { executed: false, reason: 'nothing_to_sell' };
    const fillPrice = currentPrice || pos.liveOrder.fillPrice;
    pos.liveOrder.qty     = parseFloat((totalQty - sellQty).toFixed(8));
    pos.liveOrder.usdSize = parseFloat((pos.liveOrder.qty * fillPrice).toFixed(2));
    recordTradePartialExit(pos, reason, { qty: sellQty, fillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
    if (TRADE_SIZE_MODE === 'percent') adjustPaperBalance(sellQty * fillPrice);
    telegramAlerts.push(`🟡 *PAPER PARTIAL SELL* — ${pos.base} sold ${sellQty} (${Math.round(pct * 100)}%) @ $${fillPrice.toFixed(6)} (${reason}) — ${pos.liveOrder.qty} remains open.`);
    return { executed: true, reason: 'paper_partial', qty: sellQty, fillPrice };
  }

  const symbol = pos.base + 'USDT';
  try {
    const [step, bal] = await Promise.all([
      getBaseSizePrecision(symbol),
      mexcFreeBalance(MEXC_API_KEY, MEXC_API_SECRET, pos.base, true),
    ]);
    const free = typeof bal === 'object' ? bal.free : bal;
    const sellQty = floorToStep(free * pct, step);

    const refPrice          = parseFloat(currentPrice || pos.entryPrice || 0);
    const sellNotional      = sellQty * refPrice;
    const remainderQty      = free - sellQty;
    const remainderNotional = remainderQty * refPrice;

    if (sellQty <= 0 || (refPrice > 0 && sellNotional < MIN_SELL_NOTIONAL_USDT)) {
      telegramAlerts.push(`⚠️ *PARTIAL SKIPPED* — ${pos.base} ${reason}: computed slice (~$${sellNotional.toFixed(2)}) is below MEXC's $${MIN_SELL_NOTIONAL_USDT} minimum — holding full position instead.`);
      logAudit('mexc_partial_sell_skipped_small', { sym: symbol, reason, pct, free, sellQty, sellNotional });
      return { executed: false, reason: 'slice_too_small' };
    }
    if (remainderQty > 0 && refPrice > 0 && remainderNotional < MIN_SELL_NOTIONAL_USDT) {
      // What's LEFT after this partial would be unsellable dust forever —
      // better to just fully close now than strand an unmanageable sliver.
      logAudit('mexc_partial_sell_escalated_dust_remainder', { sym: symbol, reason, pct, free, sellQty, remainderNotional });
      return { executed: false, reason: 'remainder_would_be_dust', escalateToFullClose: true };
    }

    const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, symbol, sellQty);
    pos.liveOrder.qty     = parseFloat((free - sellQty).toFixed(8));
    pos.liveOrder.usdSize = parseFloat((pos.liveOrder.qty * (pos.entryPrice || sell.fillPrice)).toFixed(2));
    telegramAlerts.push(`🟡 *PARTIAL SELL* — sold ${sellQty} ${pos.base} (${Math.round(pct * 100)}%) @ $${sell.fillPrice.toFixed(6)} on MEXC (${reason}) — ${pos.liveOrder.qty} ${pos.base} remains open.`);
    logAudit('mexc_partial_sell', { sym: symbol, reason, pct, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId, remainingQty: pos.liveOrder.qty });
    recordTradePartialExit(pos, reason, { orderId: sell.orderId, qty: sellQty, fillPrice: sell.fillPrice });
    await pushTradeLogToGitHub(loadTradeLog());
    return { executed: true, reason: 'sold', qty: sellQty, fillPrice: sell.fillPrice };
  } catch (e) {
    if (/minimum transaction volume/i.test(e.message || '')) {
      telegramAlerts.push(`⚠️ *PARTIAL SKIPPED* — ${pos.base} ${reason}: MEXC rejected the slice as below its minimum — holding full position instead.`);
      logAudit('mexc_partial_sell_skipped_dust', { sym: symbol, reason, error: e.message });
      return { executed: false, reason: 'slice_too_small' };
    }
    telegramAlerts.push(`🚨 *PARTIAL SELL FAILED* — ${pos.base} ${reason} but MEXC order errored: ${e.message} — position kept fully open, will retry next cycle.`);
    logAudit('mexc_partial_sell_failed', { sym: symbol, reason, pct, error: e.message });
    return { executed: false, reason: 'error', error: e.message };
  }
}

// ── CVD decline tracking (persisted across Job B runs) ──
// Browser uses window._cvdDeclineCount; headless uses .cvd-decline-state.json
function trackCvdDecline(sym, trending) {
  const state = loadCvdState();
  if (trending === 'down') {
    state[sym] = (state[sym] || 0) + 1;
  } else {
    state[sym] = 0;
  }
  saveCvdState(state);
  return state[sym];
}

// Returns { positions, changed, telegramAlerts[], closedOutcomes[] }
// Caller saves positions.json, pushes to GitHub, and sends telegramAlerts.
export async function monitorPositions(positions, marketSymbols, cfg = {}, marketState = {}) {
  const {
    LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9'),
    LB_BULL_CONF_MIN= parseInt(process.env.LB_BULL_CONF_MIN|| '5'),
    effectiveTradeMode = 'live',
  } = cfg;
  const now           = Date.now();
  const staleMs       = LB_STALE_WATCH_HRS * 60 * 60 * 1000;
  const holdLockMs    = SELL_MIN_POSITION_AGE_MIN * 60 * 1000;
  let   changed       = false;
  const telegramAlerts = [];
  const closedOutcomes = []; // rows for symbol-history.json — win/loss record per closed position
  const utc = new Date().toUTCString().slice(17, 22) + ' UTC';

  for (const [sym, pos] of Object.entries(positions)) {

    // ── 1. Remove terminal positions past their eviction window ──
    const termDelay = TERMINAL_EVICT_MS[pos.status];
    if (termDelay) {
      // tp1_hit has two sub-states:
      //   - holding to T2 (no exitPrice, liveOrder still open) → do NOT evict
      //   - sold at T1 (exitPrice set, liveOrder closed)       → evict normally
      if (pos.status === 'tp1_hit' && !pos.exitPrice) continue; // still holding

      // A terminal-but-unsold live position: status was stamped terminal
      // (e.g. by alert-runner.js's watchlist-style stop check, which never
      // calls closeLiveOrder()) but the liveOrder never actually got a
      // real MEXC sell. Evicting this on schedule would silently abandon a
      // real exchange balance with zero further monitoring — exactly the
      // "phantom position" bug this eviction path was already fixed for
      // once before. Give it one real close attempt here before either
      // evicting (on success/no-balance) or leaving it tracked for next
      // cycle to retry (on failure).
      const isUnsoldLive = pos.liveOrder?.mode === 'live' && !pos.liveOrder?.closedAt;
      if (isUnsoldLive) {
        const mKey  = pos.assetType === 'crypto'
          ? (sym.includes(':') ? sym.split(':').slice(1).join(':') : sym)
          : sym;
        const mData = marketSymbols[mKey];
        const price = mData?.d ? parseFloat(mData.d.p || 0) : 0;
        if (price) pos.exitPrice = price;
        console.log(`  ⚠️  ${pos.base} (${pos.status}) terminal but liveOrder still open — attempting real close before eviction`);
        const closeResult = await closeLiveOrder(pos, `${pos.status} (terminal, unsold)`, telegramAlerts, effectiveTradeMode);
        if (!closeResult.closed) {
          // Sell didn't go through (zero balance / API error) — closeLiveOrder
          // already alerted. Leave it tracked (skip eviction this cycle) so
          // the next cycle retries rather than abandoning the balance.
          delete pos.exitPrice;
          continue;
        }
        pos.statusChangedAt = now; // restart grace period from the real close
        changed = true;
        continue; // let the normal eviction window run from here next cycle
      }

      const changedAt = pos.statusChangedAt || pos.alertedAt || 0;
      if (now - changedAt >= termDelay) {
        console.log(`  🗑  ${pos.base} (${pos.status}) past eviction window → removed`);
        delete positions[sym];
        changed = true;
        logAudit('position_evicted', { sym, status: pos.status });
      }
      // Don't do any further monitoring on terminal positions
      continue;
    }

    // ── 2. Remove stale watching positions (never hit stop or target) ──
    // Live positions are handled separately below (step 3b), AFTER market
    // price is looked up — a live position needs a real sell order placed,
    // not just tracking deleted, so it needs price data to close properly.
    const isLiveHeld = pos.status === 'watching' && pos.liveOrder?.mode === 'live' && !pos.liveOrder?.closedAt;
    if (pos.status === 'watching' && !isLiveHeld) {
      const openedAt = pos.alertedAt || 0;
      if (now - openedAt >= staleMs) {
        const ageHrs = Math.round((now - openedAt) / 3600000);
        console.log(`  🗑  ${pos.base} stale ${ageHrs}h watching → evicted`);
        delete positions[sym];
        changed = true;
        logAudit('position_stale_evicted', { sym, ageHrs });
        telegramAlerts.push(
          `🗑 *STALE EVICTED* — ${pos.base}\n` +
          `  Watching ${ageHrs}h with no stop/target hit\n` +
          `  Entry $${pos.entryPrice}  Stop $${pos.stop}  ${utc}`
        );
        continue;
      }
    }

    // ── 3. Look up live market data for this position ──
    // market-fetcher.js keys market-data.json differently per asset type:
    //   crypto  → BINANCE: prefix stripped at load time, key is bare "BTCUSDT"
    //   stocks  → full exchange-prefixed symbol kept as-is, key is "NASDAQ:AAPL"
    // positions.json always stores the full prefixed symbol (sym), so we must
    // only strip the prefix for crypto — stripping it for stocks looks up a
    // key ("AAPL") that never existed in market-data.json.
    const mKey  = pos.assetType === 'crypto'
      ? (sym.includes(':') ? sym.split(':').slice(1).join(':') : sym)
      : sym;
    const mData = marketSymbols[mKey];
    if (!mData || !mData.d) {
      console.log(`  ⚠  ${pos.base} — no market data found (key: ${mKey})`);
      continue;
    }

    const d      = mData.d;
    const price  = parseFloat(d.p || 0);
    if (!price) { console.log(`  ⚠  ${pos.base} — price is 0, skipping`); continue; }

    // ── 3b. Stale LIVE position — actually close it, don't just abandon
    // tracking ──
    // This is the fix for the bug the old step-2 eviction had: a live
    // position that's been open past LB_STALE_LIVE_HRS with no stop/
    // target hit gets a REAL sell order placed here before its tracking
    // is removed, instead of just deleting the record and leaving a real
    // MEXC position open with zero further monitoring. Independent of
    // Position Intelligence (which needs actual thesis deterioration to
    // fire) and Profit Intelligence (which needs peak profit to ever
    // engage) — this is specifically for a position that's neither
    // winning nor losing, just tying up a live slot doing nothing.
    if (isLiveHeld) {
      const openedAt = pos.alertedAt || 0;
      const liveStaleMs = LB_STALE_LIVE_HRS * 3600000;
      if (now - openedAt >= liveStaleMs) {
        const ageHrs = ((now - openedAt) / 3600000).toFixed(1);
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        console.log(`  🗑💰  ${pos.base} — live position stale ${ageHrs}h (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%), closing for real`);
        pos.exitPrice = price;
        const closeResult = await closeLiveOrder(pos, `Stale — ${ageHrs}h with no stop/target hit`, telegramAlerts);
        if (!closeResult.closed) {
          delete pos.exitPrice;

          // ── Self-heal a stale position stuck at zero exchange balance ──
          // closeLiveOrder's zero_balance branch already pushed a
          // "LIVE SELL SKIPPED" alert into telegramAlerts above — without
          // this, that same alert repeats verbatim every single cycle
          // forever (this is exactly the gap reconcileTrackedLiveBalances
          // was built to close for the OTHER manual-sell-detection path;
          // this stale-close path never got the same treatment). A
          // genuinely zero real balance here almost always means the
          // position was already sold outside this exact code path (e.g.
          // reconcileTrackedLiveBalances' own balance-fetch failing
          // silently that cycle, a manual MEXC sell, or a prior partial
          // close that didn't fully update tracking) — not something more
          // retries will fix.
          if (closeResult.reason === 'zero_balance') {
            pos.liveOrder.staleZeroBalanceStrikes = (pos.liveOrder.staleZeroBalanceStrikes || 0) + 1;
            const strikes = pos.liveOrder.staleZeroBalanceStrikes;

            if (strikes >= STALE_ZERO_BALANCE_STRIKE_LIMIT) {
              // Confirmed gone across multiple cycles — close tracking
              // without a further sell attempt (nothing left to sell).
              // Same closing shape reconcileTrackedLiveBalances uses for
              // its own manual_sell_detected_zero_balance case.
              pos.status = 'stopped';
              pos.liveOrder.closedAt      = now;
              pos.liveOrder.exitFillPrice = pos.liveOrder.fillPrice; // real exit price unknown — not a bot-tracked sell
              recordTradeClose(pos, 'stale_manual_sell_detected_zero_balance', { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
              await pushTradeLogToGitHub(loadTradeLog());
              changed = true;
              logAudit('stale_position_zero_balance_closed', { sym, base: pos.base, strikes });
              clearAlertCooldown(`stale_zero_balance_${pos.base}`);
              telegramAlerts.push(
                `🔍 *STALE POSITION CLOSED — ZERO BALANCE* — ${pos.base}\n` +
                `  Stale (${ageHrs}h) sell attempt found exchange balance at 0 across ${strikes} consecutive checks — closing tracking, no sell needed.\n` +
                `  _Real exit price unknown — P&L recorded using last known fill price. If this wasn't sold manually, check reconcileTrackedLiveBalances / MEXC API health._  ${utc}`
              );
              continue;
            }

            // Not yet confirmed — rate-limit the repeat alert instead of
            // sending the identical "LIVE SELL SKIPPED" every cycle. The
            // one closeLiveOrder already queued above still goes out on
            // the FIRST strike; suppress the duplicates after that until
            // either it resolves (closes above) or the cooldown lapses.
            if (strikes > 1 && !shouldAlertOnce(`stale_zero_balance_${pos.base}`)) {
              telegramAlerts.pop(); // drop the just-pushed duplicate from closeLiveOrder
            }
          }

          continue; // sell didn't complete — retry next cycle, don't evict an unresolved live position
        }
        pos.liveOrder.staleZeroBalanceStrikes = 0; // sold successfully — clear any prior strikes
        pos.status = 'exiting';
        pos.statusChangedAt = now;
        changed = true;

        closedOutcomes.push({
          base: pos.base,
          entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + (pos.assetType === 'crypto' ? 'USDT' : ''),
          outcome: 'stale_live_closed', score: pos.score, spikeScore: pos.spikeScore,
          pnlPct: parseFloat(pnlPct.toFixed(2)) || 0, closedAt: now,
        });

        logAudit('live_position_stale_closed', { sym, ageHrs, pnlPct, closeReason: closeResult.reason });

        telegramAlerts.push(
          `🗑💰 *STALE LIVE POSITION CLOSED* — ${pos.base} — ${utc}\n` +
          `  Open ${ageHrs}h with no stop/target hit — closed to free the slot\n` +
          `  Entry $${pos.entryPrice}  Current $${price}  P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`
        );
        continue;
      }
    }

    const entry  = parseFloat(pos.entryPrice || 0);
    const t1     = parseFloat(pos.t1    || 0);
    const t2     = parseFloat(pos.t2    || 0);
    const isBull = pos.dir !== 'bear';
    const pnlPct = entry > 0 ? ((price - entry) / entry * 100).toFixed(2) : '—';

    // ── Live stop recalculation ──
    // Previously, pos.stop was a fixed value computed ONCE at buy time and
    // never touched again — changing STOP_LOSS_PCT on GitHub only affected
    // NEW buys, never anything already open. Now recalculated every cycle
    // using the CURRENT env value, so a repo-variable change takes effect
    // on already-open positions on the very next monitoring cycle, not
    // just future buys. Also serves as a live sanity check: if a stop
    // isn't moving the way you expect after changing STOP_LOSS_PCT,
    // that's a strong signal the variable isn't actually being read as
    // you think (not set, or a typo in the repo variable name) — the
    // recalculated value here reveals it directly instead of needing to
    // reverse-engineer it from a trade outcome after the fact.
    //
    // Fixed percentage of entry price — deliberately NOT volatility/ATR-
    // scaled (see calcEntryLevels() in leaderboard-decider.js for why).
    // Only tightens/loosens for a BULL position (stop below entry). A
    // bear/short position's stop sits ABOVE entry, using the same
    // percentage in the other direction — recalculated symmetrically.
    // Never recalculated past the point of no return: if the position
    // has already moved to tp1_hit (holding for T2), its stop should have
    // already been adjusted by that logic elsewhere and this recalculation
    // is skipped so it doesn't fight with that.
    const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.1');
    let stop = parseFloat(pos.stop || 0);
    if (entry > 0 && pos.status !== 'tp1_hit') {
      const recalculated = isBull
        ? entry * (1 - STOP_LOSS_PCT / 100)
        : entry * (1 + STOP_LOSS_PCT / 100);
      const dp = priceDecimals(entry);
      const recalcRounded = parseFloat(recalculated.toFixed(dp));
      if (recalcRounded !== stop) {
        console.log(`  🔧  ${pos.base} stop recalculated: ${stop} → ${recalcRounded} (STOP_LOSS_PCT=${STOP_LOSS_PCT}%)`);
        pos.stop = recalcRounded;
        stop = recalcRounded;
        changed = true;
      }
    }
    const isCrypto = pos.assetType === 'crypto';

    // ── 4. Price-based exits (immediate, no hold lock, no score needed) ──

    // Stop hit
    if (isBull && stop > 0 && price <= stop) {
      console.log(`  🔴  STOP HIT — ${pos.base} price:${price} stop:${stop}`);
      pos.exitPrice = price; // tentative fill price, used by closeLiveOrder's paper branch
      const closeResult  = await closeLiveOrder(pos, 'stop hit', telegramAlerts, effectiveTradeMode);
      const isLiveCrypto = isCrypto && pos.liveOrder?.mode === 'live';
      if (isLiveCrypto && !closeResult.closed) {
        // Exchange sell didn't actually happen (zero balance / API error) —
        // closeLiveOrder already alerted. Don't mark this terminal or the
        // position gets evicted while possibly still open on the exchange;
        // leave it tracked so this same stop check fires again next cycle.
        delete pos.exitPrice;
        continue;
      }
      pos.status          = 'stopped';
      pos.statusChangedAt = now;
      changed = true;
      logAudit('stop_hit', { sym, price, stop, entry, pnlPct, closeReason: closeResult.reason });
      closedOutcomes.push({
        base: pos.base,
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + (isCrypto ? 'USDT' : ''),
        outcome: 'stopped', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });
      // Wording is gated on isLiveCrypto (an actual MEXC order existed),
      // not just isCrypto — a crypto symbol can be tracked/watchlist-only
      // (stocks/ETFs/crypto all share this tracker, and the bot doesn't
      // auto-trade every crypto symbol it watches). Without this, a
      // watchlist-only crypto hitting its tracked stop said "SOLD" /
      // "Position removed" exactly like a real live-order close, even
      // though nothing was ever bought or sold on the exchange.
      telegramAlerts.push(
        `🔴 *STOP HIT${isLiveCrypto ? ' — SOLD' : isCrypto ? ' — SIGNAL CLOSED (watchlist only)' : ' — CLOSE MANUALLY'}* — ${pos.base} — ${utc}\n` +
        `  Entry $${entry}  Stop $${stop}  Current $${price}\n` +
        `  P&L ${pnlPct}%  Setup: ${pos.setup}\n` +
        (isLiveCrypto ? `  _Position removed in 5 min_` : isCrypto ? `  _Tracked signal only — no live position was held_` : `  _Close your position manually on the exchange_`)
      );
      continue;
    }

    // T2 hit — retained for paper/legacy positions opened before T1-sell was introduced.
    if (isBull && t2 > 0 && price >= t2 && pos.status === 'tp1_hit') {
      console.log(`  🏆  T2 HIT (legacy) — ${pos.base} price:${price} t2:${t2}`);
      pos.exitPrice = price;
      const closeResult  = await closeLiveOrder(pos, 'T2 hit', telegramAlerts, effectiveTradeMode);
      const isLiveCrypto = isCrypto && pos.liveOrder?.mode === 'live';
      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;
        continue; // sell didn't complete — retry next cycle, don't evict
      }
      pos.status          = 'tp2_hit';
      pos.statusChangedAt = now;
      changed = true;
      logAudit('tp2_hit', { sym, price, t2, entry, pnlPct, closeReason: closeResult.reason });
      closedOutcomes.push({
        base: pos.base,
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + (isCrypto ? 'USDT' : ''),
        outcome: 'tp2_hit', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });
      telegramAlerts.push(
        `🏆 *T2 HIT${isLiveCrypto ? ' — SOLD' : isCrypto ? ' — SIGNAL CLOSED (watchlist only)' : ' — CLOSE MANUALLY'}* — ${pos.base} — ${utc}\n` +
        `  T2 $${t2}  Current $${price}  Entry $${entry}\n` +
        `  P&L +${pnlPct}%  Full target reached\n` +
        (isLiveCrypto ? `  _Position removed in 8 min_` : isCrypto ? `  _Tracked signal only — no live position was held_` : `  _Close your position manually on the exchange_`)
      );
      continue;
    }

    // ── T1 hit — re-evaluate before selling ──
    // If signal is still strong (conv ≥ LB_MIN_SCORE AND bullConf ≥ LB_BULL_CONF_MIN),
    // hold the position and let it run to T2 — no fees, no spread, no re-entry cost.
    // Only sell if the signal has faded, meaning holding is no longer justified.
    if (isBull && t1 > 0 && price >= t1 && pos.status === 'watching') {
      const mKey   = pos.assetType === 'crypto'
        ? (sym.includes(':') ? sym.split(':').slice(1).join(':') : sym)
        : sym;
      const live   = marketSymbols[mKey];
      const liveD  = live?.d || {};
      const liveConv    = calcConviction(liveD);
      const liveBullConf = parseFloat(liveD.bullConf ?? liveD.bull_conf ?? 0);
      const stillQualifies = liveConv >= LB_MIN_SCORE && liveBullConf >= LB_BULL_CONF_MIN;

      if (stillQualifies) {
        // Signal still strong — hold, move to tp1_hit status (watching for T2/stop/exit)
        // but do NOT sell and do NOT call closeLiveOrder
        if (pos.status !== 'tp1_hit') {
          pos.status          = 'tp1_hit';
          pos.statusChangedAt = now;
          pos.t1HitAt         = now;
          changed             = true;
          logAudit('tp1_hit_hold', { sym, price, t1, liveConv, liveBullConf });
          telegramAlerts.push(
            `✅ *T1 HIT — HOLDING* — ${pos.base} — ${utc}\n` +
            `  T1 $${t1}  Price $${price}  Entry $${entry}\n` +
            `  P&L +${pnlPct}%  Conv:${liveConv} BullConf:${liveBullConf}/10 — signal still strong\n` +
            `  _Holding to T2 $${t2} — stop moved mentally to T1_`
          );
        }
        continue; // keep watching — T2/stop/exit score will handle exit
      }

      // Signal faded — sell now, take profit at T1
      console.log(`  ✅  T1 HIT — ${pos.base} price:${price} conv:${liveConv}(need ${LB_MIN_SCORE}) bullConf:${liveBullConf}(need ${LB_BULL_CONF_MIN})${isCrypto ? ' — selling (signal faded)' : ' — close manually'}`);
      pos.exitPrice = price;
      const closeResult  = await closeLiveOrder(pos, 'T1 hit (signal faded)', telegramAlerts, effectiveTradeMode);
      const isLiveCrypto = isCrypto && pos.liveOrder?.mode === 'live';
      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;
        continue; // sell didn't complete — retry next cycle, don't evict
      }
      pos.status          = 'tp1_hit';
      pos.statusChangedAt = now;
      changed             = true;
      logAudit('tp1_hit_sell', { sym, price, t1, liveConv, liveBullConf, pnlPct, closeReason: closeResult.reason });
      closedOutcomes.push({
        base: pos.base,
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + (isCrypto ? 'USDT' : ''),
        outcome: 'tp1_hit', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });
      telegramAlerts.push(
        `✅ *T1 HIT${isCrypto ? ' — SOLD' : ' — CLOSE MANUALLY'}* — ${pos.base} — ${utc}\n` +
        `  T1 $${t1}  Price ~$${price}  Entry $${entry}\n` +
        `  P&L +${pnlPct}%  Conv:${liveConv} BullConf:${liveBullConf}/10 — signal faded\n` +
        (isCrypto ? `  _Sold on MEXC — slot freed_` : `  _Close your position manually on the exchange_`)
      );
      continue;
    }

    // ── 5. Hold lock — no exit score during first N minutes ──
    const holdLockUntil = (pos.alertedAt || 0) + holdLockMs;
    if (now < holdLockUntil) {
      const remMins = Math.ceil((holdLockUntil - now) / 60000);
      console.log(`  ⏳  ${pos.base} — hold lock ${remMins}min remaining`);
      continue;
    }

    // ── 5b. Position Intelligence Engine (v15 design doc, sell-side) ──
    // Positions with an entrySnapshot (set at buy time by mexc-trader.js —
    // see buildEntrySnapshot()) get the full thesis/confidence/falling-knife
    // composite. Positions without one (manually adopted, or pre-dating this
    // feature) still get evaluated — evaluatePosition() runs a falling-knife-
    // only fallback for those (see its no-snapshot branch), since knife
    // scoring only needs current market state, not an entry comparison.
    // EXIT / EMERGENCY_EXIT reuse the same proven closeLiveOrder() full-close
    // path as every other exit above. REDUCE_25 / REDUCE_50 (partial exits)
    // auto-execute via closeLiveOrderPartial() when SELL_AUTO_PARTIAL_EXIT=true
    // (off by default) — crypto only, each level fires at most once per
    // position (pos.piPartialLevel). With it off, or for non-crypto
    // positions, these stay a Telegram recommendation for manual action.
    if (isCrypto && positionIntelligenceEnabled()) {
      const symbolState = marketState?.symbols?.[mKey];
      const pi = evaluatePosition({
        pos, currentEntry: mData, symbolState, marketState, pnlPct: parseFloat(pnlPct) || 0,
      });

      // Persist the latest read on the position itself (regardless of
      // action) so the dashboard can show live PI diagnostics without a
      // separate data source — cheap, small, and always the freshest read.
      if (!pi.skipped) {
        pos.lastPI = {
          action: pi.action, reason: pi.reason,
          fallingKnifeScore: pi.fallingKnifeScore, thesisDrop: pi.thesisDrop,
          confidenceDecay: pi.confidenceDecay, exitProbability: pi.exitProbability,
          dynamicPositionRisk: pi.dynamicPositionRisk, recovery: pi.recovery,
          breakoutFailed: pi.breakoutFailed || false,
          noSnapshotFallback: pi.noSnapshotFallback || false,
          evaluatedAt: now,
        };
        changed = true;
      }

      if (!pi.skipped && pi.action !== 'HOLD') {
        console.log(`  🧠  ${pos.base} — Position Intelligence: ${pi.action} (${pi.reason})`);
        logAudit('position_intelligence', {
          sym, action: pi.action, reason: pi.reason, fallingKnifeScore: pi.fallingKnifeScore,
          thesisDrop: pi.thesisDrop, confidenceDecay: pi.confidenceDecay,
          exitProbability: pi.exitProbability, dynamicPositionRisk: pi.dynamicPositionRisk,
        });

        if (pi.action === 'EXIT' || pi.action === 'EMERGENCY_EXIT') {
          pos.exitPrice = price;
          const closeResult  = await closeLiveOrder(pos, `position intelligence: ${pi.reason}`, telegramAlerts, effectiveTradeMode);
          const isLiveCrypto = pos.liveOrder?.mode === 'live';
          if (isLiveCrypto && !closeResult.closed) {
            delete pos.exitPrice;
            continue; // sell didn't complete — retry next cycle, don't evict
          }
          pos.status          = 'exiting';
          pos.statusChangedAt = now;
          pos.exitAlertedAt   = now;
          changed             = true;
          closedOutcomes.push({
            base: pos.base,
            entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + 'USDT',
            outcome: pi.action === 'EMERGENCY_EXIT' ? 'emergency_exit' : 'pi_exit',
            score: pos.score, spikeScore: pos.spikeScore,
            pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
          });
          const emoji = pi.action === 'EMERGENCY_EXIT' ? '🚨' : '🧠';
          telegramAlerts.push(
            `${emoji} *${pi.action === 'EMERGENCY_EXIT' ? 'EMERGENCY EXIT' : 'POSITION INTELLIGENCE EXIT'}${isCrypto ? ' — SOLD' : ' — CLOSE MANUALLY'}* — ${pos.base} — ${utc}\n` +
            `  ${pi.reason}\n` +
            `  Exit prob ${pi.exitProbability} · Falling knife ${pi.fallingKnifeScore} · Confidence decay ${pi.confidenceDecay}%\n` +
            `  Price ~$${price}  Entry $${entry}  P&L ${pnlPct}%`
          );
          continue;
        }

        // REDUCE_25 / REDUCE_50 — auto-executed via closeLiveOrderPartial when
        // AUTO_PARTIAL_EXIT is on (crypto only; each level fires at most once
        // per position — pos.piPartialLevel tracks 0/1/2 so a risk score
        // sitting in the same band across several cycles doesn't re-cut the
        // position every single cycle). Falls back to alert-only for
        // non-crypto positions, or whenever AUTO_PARTIAL_EXIT is off.
        const levelNum = pi.action === 'REDUCE_25' ? 1 : 2;
        const alreadyAtLevel = (pos.piPartialLevel || 0) >= levelNum;

        if (isCrypto && AUTO_PARTIAL_EXIT && !alreadyAtLevel) {
          const pct = pi.action === 'REDUCE_25' ? 0.25 : 0.5;
          const partial = await closeLiveOrderPartial(pos, pct, `position intelligence: ${pi.reason}`, price, telegramAlerts, effectiveTradeMode);

          if (partial.executed) {
            pos.piPartialLevel = levelNum;
            changed = true;
            logAudit('position_intelligence_partial', { sym, action: pi.action, level: levelNum, qty: partial.qty, fillPrice: partial.fillPrice });
          } else if (partial.escalateToFullClose) {
            // Remainder after the partial would be unsellable dust — do a
            // full close instead, same path as a normal EXIT.
            pos.exitPrice = price;
            const closeResult = await closeLiveOrder(pos, `position intelligence: ${pi.reason} (partial would leave dust — full close instead)`, telegramAlerts, effectiveTradeMode);
            if (!closeResult.closed) { delete pos.exitPrice; continue; }
            pos.status = 'exiting'; pos.statusChangedAt = now; pos.exitAlertedAt = now; changed = true;
            closedOutcomes.push({
              base: pos.base,
              entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + 'USDT', outcome: 'pi_exit',
              score: pos.score, spikeScore: pos.spikeScore, pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
            });
            continue;
          }
          // slice_too_small / error / nothing_to_sell — closeLiveOrderPartial
          // already alerted; position stays open, retried next cycle if the
          // condition persists (no separate cooldown needed here since the
          // level guard above prevents re-attempting after any success).
        } else {
          // Alert-only path (non-crypto, or AUTO_PARTIAL_EXIT off) — same
          // cooldown as before so this doesn't spam every cycle.
          const reduceCooldown = 30 * 60 * 1000;
          if (!pos.piReduceAlertedAt || now - pos.piReduceAlertedAt > reduceCooldown) {
            pos.piReduceAlertedAt = now;
            changed = true;
            const manualNote = !isCrypto
              ? '_Non-crypto — no execution path, reduce manually._'
              : alreadyAtLevel
                ? '_Already reduced at this level — holding._'
                : '_Auto partial-exit is OFF (SELL_AUTO_PARTIAL_EXIT) — reduce manually if you agree._';
            telegramAlerts.push(
              `⚠️ *POSITION INTELLIGENCE — ${pi.action.replace('_', ' ')} RECOMMENDED* — ${pos.base} — ${utc}\n` +
              `  ${pi.reason}\n` +
              `  Exit prob ${pi.exitProbability} · Falling knife ${pi.fallingKnifeScore} · Confidence decay ${pi.confidenceDecay}%\n` +
              `  Price $${price}  Entry $${entry}  P&L ${pnlPct}%\n` +
              `  ${manualNote}`
            );
          }
        }
      }
    }

    // ── 5c. Profit Intelligence Engine (Design Proposal, Aug 2026) ──
    // Independent of Position Intelligence (5b) and the CVD/OI/FR/RSI exit
    // score (6) below — those protect against a broken thesis; this
    // protects unrealized PROFIT that's giving itself back, even while the
    // thesis technically still holds. New sell reason: "Profit Protection
    // Triggered". See profit-intelligence.js for the full design writeup.
    if (profitIntelligenceEnabled()) {
      const symbolState = marketState?.symbols?.[mKey];
      const pp = evaluateProfitProtection({
        pos, symbolState, marketState, r15: parseFloat(d.r15), pnlPct: parseFloat(pnlPct),
      });

      // Persist the latest read (peak, drawdown, tier) on the position
      // itself, same pattern as pos.lastPI, so the dashboard can show it
      // without a separate data source.
      if (!pp.skipped || pp.highestPnLSeen != null) {
        pos.lastProfitIntel = {
          action: pp.action, reason: pp.reason,
          highestPnLSeen: pp.highestPnLSeen, drawdownFromPeak: pp.drawdownFromPeak,
          tier: pp.tier || null, giveBack: pp.giveBack ?? null,
          evaluatedAt: now,
        };
        changed = true;
      }

      if (pp.action === 'EXIT') {
        console.log(`  💰  ${pos.base} — Profit Protection Triggered (${pp.reason})`);
        pos.exitPrice = price;
        const closeResult  = await closeLiveOrder(pos, 'Profit Protection Triggered', telegramAlerts, effectiveTradeMode);
        const isLiveCrypto = isCrypto && pos.liveOrder?.mode === 'live';
        if (isLiveCrypto && !closeResult.closed) {
          delete pos.exitPrice;
          continue; // sell didn't complete — retry next cycle, don't evict
        }
        pos.status          = 'exiting';
        pos.statusChangedAt = now;
        pos.exitAlertedAt   = now;
        changed              = true;

        closedOutcomes.push({
          base: pos.base,
          entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + (isCrypto ? 'USDT' : ''),
          outcome: 'profit_protection', score: pos.score, spikeScore: pos.spikeScore,
          pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
        });

        logAudit('profit_protection_triggered', {
          sym, price, entry, pnlPct, highestPnLSeen: pp.highestPnLSeen,
          drawdownFromPeak: pp.drawdownFromPeak, tier: pp.tier, giveBack: pp.giveBack,
          closeReason: closeResult.reason,
        });

        telegramAlerts.push(
          `💰 *PROFIT PROTECTION TRIGGERED${isLiveCrypto ? ' — SOLD' : isCrypto ? ' — SIGNAL CLOSED (watchlist only)' : ' — CLOSE MANUALLY'}* — ${pos.base} — ${utc}\n` +
          `  Peak +${pp.highestPnLSeen.toFixed(2)}% (tier ${pp.tier}) → now ${pnlPct >= 0 ? '+' : ''}${pnlPct}%  Gave back ${pp.drawdownFromPeak.toFixed(2)}% ≥ ${pp.giveBack}%\n` +
          `  Entry $${entry}  Current $${price}\n` +
          (isLiveCrypto ? `  _Position removed in 5 min_` : isCrypto ? `  _Tracked signal only — no live position was held_` : `  _Close your position manually on the exchange_`)
        );
        continue; // slot freed, no further checks this cycle
      }
    }

    // ── 6. Exit score — CVD + OI + FR + RSI ──
    // CVD is the hard gate: must decline LB_EXIT_CVD_CYCLES consecutive Job B runs
    const cvdTrending  = d.cvd?.trending || d.cvdTrend || 'up';
    const cvdDeclines  = trackCvdDecline(sym, cvdTrending);
    const cvdConfirmed = cvdDeclines >= LB_EXIT_CVD_CYCLES;

    const fr          = parseFloat(d.fr    || 0);
    const r15         = parseFloat(d.r15   || 50);
    const oiStr       = (d.oiDiv || '').toLowerCase();
    const chg         = parseFloat(d.chg   || 0);
    const priceNearEntry = Math.abs(chg) < 0.5 || price < entry * 1.005;
    const oiExiting   = (oiStr.includes('bear oi') || oiStr.includes('oi drop')) && priceNearEntry;
    const fundingHot  = fr > 0.08;
    const rsiExtended = r15 > 75;

    let exitScore = 0;
    if (cvdConfirmed)                       exitScore += 2; // hard gate contribution
    if (oiExiting)                          exitScore += 2;
    if (fundingHot)                         exitScore += 1;
    if (rsiExtended && cvdDeclines >= 1)    exitScore += 1;

    console.log(`  📊  ${pos.base} — price:$${price} pnl:${pnlPct}% exitScore:${exitScore}/6 cvd:${cvdTrending}(${cvdDeclines}) fr:${fr.toFixed(3)}%`);

    // ── Tier 1: Overheating warning (no CVD needed) ──
    const tier1Triggered = fundingHot && rsiExtended && !cvdConfirmed;
    const tier1Cooldown  = 2 * 60 * 60 * 1000;
    if (tier1Triggered && (!pos.tier1AlertedAt || now - pos.tier1AlertedAt > tier1Cooldown)) {
      pos.tier1AlertedAt = now;
      changed = true;
      console.log(`  ⚠  ${pos.base} — OVERHEATING FR:${fr.toFixed(3)}% RSI:${Math.round(r15)}`);
      telegramAlerts.push(
        `⚠ *WATCH — Overheating* — ${pos.base} — ${utc}\n` +
        `  FR ${fr.toFixed(3)}%  RSI 15m ${Math.round(r15)}\n` +
        `  CVD still up — tighten stop, not yet an exit\n` +
        `  Current $${price}  Entry $${entry}  P&L ${pnlPct}%`
      );
    }

    // ── Tier 2: Distribution confirmed — SELL immediately ──
    // CVD declining 3+ cycles + supporting signals = real distribution.
    // Sell now to minimise loss and free the slot for the next buy signal.
    // No cooldown guard needed — once we sell, status becomes 'exiting'
    // (terminal) so this block can't fire again on the same position.
    if (cvdConfirmed && exitScore >= LB_EXIT_SCORE_MIN) {
      const signals = [
        `CVD↓ ${cvdDeclines} cycles`,
        oiExiting   ? 'OI distributing'      : null,
        fundingHot  ? `FR ${fr.toFixed(3)}%` : null,
        rsiExtended ? `RSI ${Math.round(r15)}` : null,
      ].filter(Boolean).join(' · ');

      console.log(`  🟡  ${pos.base} — EXIT SIGNAL score:${exitScore}/6 [${signals}] — selling`);
      pos.exitPrice = price;
      const closeResult  = await closeLiveOrder(pos, 'momentum exit', telegramAlerts, effectiveTradeMode);
      const isLiveCrypto = isCrypto && pos.liveOrder?.mode === 'live';
      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;
        continue; // sell didn't complete — retry next cycle, don't evict
      }
      pos.status          = 'exiting';
      pos.statusChangedAt = now;
      pos.exitAlertedAt   = now;
      changed             = true;

      closedOutcomes.push({
        base: pos.base,
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null, pair: pos.base + (pos.assetType === 'crypto' ? 'USDT' : ''),
        outcome: 'exit_score', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct: parseFloat(pnlPct) || 0, closedAt: now,
      });

      logAudit('exit_signal_sell', { sym, exitScore, signals, price, pnlPct, closeReason: closeResult.reason });

      telegramAlerts.push(
        `🟡 *MOMENTUM EXIT${isCrypto ? ' — SOLD' : ' — CLOSE MANUALLY'}* — ${pos.base} — ${utc}\n` +
        `  Score ${exitScore}/6 · ${signals}\n` +
        `  ${isCrypto ? 'Fill' : 'Price'} ~$${price}  Entry $${entry}  P&L ${pnlPct}%\n` +
        (isCrypto ? `  _Sold on MEXC — slot freed for next signal_` : `  _Close your position manually on the exchange_`)
      );
      continue; // slot freed, no further checks
    }
  }

  return { positions, changed, telegramAlerts, closedOutcomes };
}
