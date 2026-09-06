// ══════════════════════════════════════════════════════════════════════════════
// mexc-trader.js — MEXC auto-trade execution
//
// Two things happen here, in order, both gated by effectiveTradeMode !== 'off':
//
//   1. A/A+ ROTATION — if any NEW candidate this cycle is Grade A or A+ (a
//      combined BullConf + whaleScore signal from leaderboard-scanner.js),
//      sell ALL currently live positions first so their slots free up for
//      the new picks. Paper mode logs the rotation without exchange calls.
//
//   2. STAR-PICK AUTO-BUY — buys the top-ranked ⭐ recommended symbol(s) via
//      MEXC market order (or logs a paper fill), gated by tradingEnabled,
//      idempotency, and the live-position concurrency cap.
//
// Both were previously inline in leaderboard-decider.js's main(). Note: the
// original rotation block referenced a bare `closedOutcomes` array that was
// never declared in main()'s scope (it only existed inside monitorPositions)
// — this would have thrown a ReferenceError the first time an A/A+ signal
// actually fired. Fixed here by taking closedOutcomes as an explicit param.
// ══════════════════════════════════════════════════════════════════════════════

import { mexcMarketBuy, mexcMarketSell, mexcFreeBalance, mexcGetAllBalances, mexcGetMyTrades, mexcGetLivePrice, getBaseSizePrecision, floorToStep } from './mexc-client.js';
import { closeLiveOrder, countLiveOpenPositions } from './position-monitor.js';
import { isMomentumWeak } from './profit-intelligence.js';
import { buildEntrySnapshot } from './position-intelligence.js';
import { calcEntryExtension } from './buy-intelligence.js';
import { checkExhaustedEntry, checkFallingKnife } from './st-timing-engine.js';
import { buildSymKey } from './exchange-registry.js';
import { sendTelegram } from './telegram-commands.js';
import {
  logAudit, MEXC_API_KEY, MEXC_API_SECRET,
  loadTradeLog, recordTradeOpen, recordTradeClose, pushTradeLogToGitHub, hasOpenTradeLogEntry,
  loadPaperBalance, adjustPaperBalance,
} from './job-state.js';

// ── Post-fill level resync — anchors entryPrice/stop/t1/t2 to the price
// ACTUALLY paid, not the pre-fill reference estimate calcEntryLevels()
// computed (leaderboard-scanner.js / leaderboard-decider.js) before the
// order executed. Matters most for live orders: mexc-client.js's
// mexcMarketBuy() already derives a real fill price from MEXC's own
// cummulativeQuoteQty / executedQty (not the unreliable `price` field on
// market-order responses — see mexc-client.js), but until now that real
// price was only ever stored on pos.liveOrder.fillPrice — pos.entryPrice
// (what stop-recalculation and P&L in position-monitor.js actually use)
// stayed pinned to the pre-fill estimate for the position's whole
// lifetime. Same formula as calcEntryLevels(), just anchored to the real
// fill instead of the estimate, and with no chase markup to undo.
function recalcLevelsFromFill(fillPrice, shock = 1) {
  const p = parseFloat(fillPrice) || 0;
  if (!p) return null;
  const atr = p * 0.015 * Math.max(1, shock * 0.5);
  const dp  = p < 10 ? 4 : 2;
  const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.1');
  return {
    stop: parseFloat((p * (1 - STOP_LOSS_PCT / 100)).toFixed(dp)),
    t1:   parseFloat((p + atr * 2).toFixed(dp)),
    t2:   parseFloat((p + atr * 4).toFixed(dp)),
  };
}

// ── Symbols that can alert/star normally but must NEVER be auto-traded ──
// Default: empty — ALL symbols are tradeable unless explicitly listed here.
// These still flow through leaderboard-decider's scan and Telegram messages
// either way; listing a symbol only excludes it from A/A+ rotation and the
// star-pick auto-buy (e.g. so capital stays in alts that spike/dip harder
// than BTC once you decide to exclude it).
// Set via repo Variable MEXC_NO_TRADE_SYMBOLS, e.g. "BTCUSDT,ETHUSDT".
// Leave the variable unset/empty to allow auto-trading on every symbol.
const NO_TRADE_SYMBOLS = (process.env.MEXC_NO_TRADE_SYMBOLS || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function isNoTradeSymbol(pair) {
  const bare = (pair || '').replace(/^BINANCE:/, '').toUpperCase();
  return NO_TRADE_SYMBOLS.includes(bare);
}

// ── Minimum grade required to actually move real money ──
// 'recommended' (top-ranked by rankScore = conviction + bullConf, plus a
// history bonus) does NOT by itself require a strong grade — a symbol can
// rank #1 this cycle purely on current signal strength while its own
// grade (calcGrade, from bullConf + whaleScore) still reads B or C. This
// gate adds a hard floor so buys and rotation-sells only fire on A/A+
// setups; a weaker recommended pick still shows up starred in the
// Telegram alert and Position Tracker as informational, it just isn't
// traded. Especially important with LB_RECO_MIN_SIGNALS=1, where a single
// mediocre-grade signal would otherwise be enough to rotate and buy.
// Set via repo Variable EXEC_MIN_GRADE: 'A' (default — A or A+ both pass),
// 'A+' (A+ only), 'B' (B/A/A+ pass), 'C' (C/B/A/A+ pass), 'D' (everything
// passes), or 'off' (no gate — every recommended pick is tradeable).
// True ordinal comparison — A+ > A > B > C > D — so EXEC_MIN_GRADE=B
// actually does something (previously hardcoded to only ever check for
// 'A+' or 'A', silently ignoring any other value including 'B').
const GRADE_RANK = { 'A+': 5, 'A': 4, 'B': 3, 'C': 2, 'D': 1 };
const EXEC_MIN_GRADE = (process.env.EXEC_MIN_GRADE || 'A').toUpperCase();
function meetsGradeGate(grade) {
  if (EXEC_MIN_GRADE === 'OFF') return true;
  const minRank = GRADE_RANK[EXEC_MIN_GRADE];
  const gradeRank = GRADE_RANK[grade];
  if (minRank == null) return grade === 'A' || grade === 'A+'; // unrecognized EXEC_MIN_GRADE value — fall back to the old A/A+ default rather than silently passing everything
  if (gradeRank == null) return false; // unrecognized/missing grade never passes a real gate
  return gradeRank >= minRank;
}

// Never treat these as "open positions" to rotate out of — they're buying
// power, not a trade.
const QUOTE_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'DAI', 'FDUSD']);

// Same threshold + env var as position-monitor.js's closeLiveOrder dust
// guard — a balance worth less than this can't be sold on MEXC at all, so
// skip attempting it here too rather than retrying (and re-alerting) a
// doomed order every rotation cycle.
const MIN_SELL_NOTIONAL_USDT = parseFloat(process.env.MEXC_MIN_SELL_NOTIONAL_USDT || '5');


// ── Rotation — sell anything held that's not in THIS cycle's buy alert ──
// Fires on ANY cycle where a star-pick/topN buy alert actually fires. Rule
// is strict and uniform for every currently-held position (tracked or not):
//   - base symbol IS one of this cycle's buy-alert candidates → PROTECTED,
//     left alone.
//   - base symbol is NOT one of this cycle's candidates → sold now, to fund
//     the new pick(s) — including a position that's already hit T1 and is
//     being held for T2. Only a symbol actually named in today's alert
//     survives; "still looks strong on its own" is not enough.
// In LIVE mode this is reconciled against the REAL MEXC account balance, not
// just positions.json — so a coin bought manually outside the bot (which the
// bot would otherwise have no idea about) is still seen and rotated exactly
// like a bot-opened position. Paper mode has no real balance to check
// against, so it still uses positions.json only.
// Stop-loss exits are entirely separate (position-monitor.js) and are
// unaffected by any of this — but note the exchange-side stop for a
// rotated-out position gets cancelled here via closeLiveOrder's own
// reconciliation logic before the rotation sell executes.
async function executeRotation({ ranked, showRecoTags, effectiveExecStrategy, effectiveTopNCount, positions, market, marketState = {}, tradeState, effectiveTradeMode, closedOutcomes, utc }) {
  let changed = false;

  const allStarred = (ranked || []).filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair) && meetsGradeGate(r.a.entry.grade)
  );
  const rotationPicks = effectiveExecStrategy === 'topN'
    ? (effectiveTopNCount ? allStarred.slice(0, effectiveTopNCount) : allStarred)
    : allStarred.slice(0, 1);

  const shouldRotate = showRecoTags
    && rotationPicks.length > 0
    && effectiveTradeMode !== 'off'
    && tradeState.tradingEnabled;

  const rotationCandidates = rotationPicks.map(r => r.a); // shape compatible with old {pair, entry} usage below

  if (!shouldRotate) return { changed, rotationCandidates: [] };

  // Bases that qualify as this cycle's top A/A+ picks — the STRICT rule:
  // anything currently held that's already one of these is always left
  // alone, at any hold time.
  const topBases = new Set(rotationCandidates.map(c => c.pair.replace(/[^A-Z]/g, '').replace(/USDT$/, '')));
  const gradeStillTop = (base) => topBases.has(base);

  // ── Guard 1: minimum hold time ──
  // Stage 1 (< ROTATION_MIN_HOLD_MIN since buy): UNCONDITIONALLY protected
  // — a fresh buy is never rotated out purely because a different symbol
  // outranks it one cycle later. Stage 2 (past the window): this
  // protection expires; only gradeStillTop (above) and Guard 2 (below) can
  // still protect it.
  const ROTATION_MIN_HOLD_MIN = parseFloat(process.env.ROTATION_MIN_HOLD_MIN || '30');
  const withinMinHold = (pos) => {
    if (!pos?.liveOrder?.buyAt || ROTATION_MIN_HOLD_MIN <= 0) return false;
    return (Date.now() - pos.liveOrder.buyAt) / 60000 < ROTATION_MIN_HOLD_MIN;
  };

  // ── Guard 2: never rotate out a position that isn't MEANINGFULLY profitable ──
  // Rotation may only sell a held position to fund a new A/A+ pick if that
  // position's CURRENT price clears its own buy price by at least
  // ROTATION_SELL_MIN_NET_PNL_PCT. A position at/below that margin is left alone
  // regardless of rank/grade — it can only be closed by its own stop, T1,
  // or T2 (evaluated separately, upstream, in monitorPositions/STEP 1 —
  // never by rotation). This trades "may hold a stale/mediocre position
  // longer, occupying a live slot" for "never lock in a rotation-driven
  // loss on a position that hasn't hit its own stop" — a deliberate choice
  // given the trade-log review showing rotation churn (not stop hits) as
  // the more frequent source of small losses.
  //
  // The margin matters, not just the sign: a rotation sell is a real market
  // order paying real fees on both legs (the original buy + this sell),
  // plus slippage. A position that's only fractionally above its fill price
  // (the old ">= buyPrice" check) reads as "profitable" on paper but nets a
  // realized LOSS the instant fees are applied — exactly the outcome this
  // guard exists to prevent. ROTATION_SELL_MIN_NET_PNL_PCT sets the buffer above
  // fill price required before rotation is allowed to touch it; tune it to
  // comfortably clear your actual MEXC round-trip fee + expected slippage.
  //
  // Requires a current price from market.symbols to evaluate; if
  // unavailable, this guard has no opinion (falls through to the other
  // guards) rather than blocking or allowing by default.
  const ROTATION_SELL_MIN_NET_PNL_PCT = parseFloat(process.env.ROTATION_MIN_PROFIT_PCT || '0.2');
  // Same setup-aware bump as ST5/ST15's own rotation guard (see the
  // comment there for the trade-log rationale) — normal rotation can
  // also reach an ST5/ST15-origin holding, so it needs the same higher
  // bar or that position could still get harvested early via THIS path
  // even with the ST5/ST15-side fix in place.
  const ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT = parseFloat(process.env.ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT || '1');
  const currentlyAtOrAboveBuy = (base, pos) => {
    const buyPrice = pos?.liveOrder?.fillPrice;
    if (!buyPrice) return null; // no opinion — no buy price on record to compare against
    const cur = (market.symbols || {})[base + 'USDT']?.price;
    if (cur === undefined || cur === null) return null; // no opinion — no current price available
    const minPct = ['ST5 PRIORITY', 'ST15 PRIORITY'].includes(pos?.setup) ? ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT : ROTATION_SELL_MIN_NET_PNL_PCT;
    return parseFloat(cur) >= parseFloat(buyPrice) * (1 + minPct / 100);
  };

  // ── Stagnation override — waives Guard 2's flat-position protection ──
  // Guard 2 above protects ANY position below its profit margin,
  // including one that's simply sitting flat with no real momentum
  // either way — which meant a stagnant position was permanently shielded
  // from rotation, tying up a live slot indefinitely even after it fell
  // off the recommended list entirely. This only waives that specific
  // protection — Guard 3 (still genuinely recommended) and Guard 1 (min
  // hold time) still fully apply, so a stagnant-but-still-liked position
  // stays protected. This only affects a position that's BOTH old enough
  // to have had a real chance to move AND still near its own fill price
  // with no real movement — same threshold philosophy as Position
  // Intelligence's stale+flat nudge (SELL_STALE_NUDGE_*), applied here to
  // rotation eligibility instead of exit probability.
  const STAGNATION_AGE_MIN  = parseFloat(process.env.ROTATION_STAGNATION_AGE_MIN  || '120'); // 2h
  const STAGNATION_FLAT_PCT = parseFloat(process.env.ROTATION_STAGNATION_FLAT_PCT || '0.3');
  const isStagnant = (base, pos) => {
    if (!pos?.liveOrder?.buyAt) return false;
    const ageMin = (Date.now() - pos.liveOrder.buyAt) / 60000;
    if (ageMin < STAGNATION_AGE_MIN) return false;
    const buyPrice = pos?.liveOrder?.fillPrice;
    const cur = (market.symbols || {})[base + 'USDT']?.price;
    if (!buyPrice || cur === undefined || cur === null) return false;
    const pnlPct = ((parseFloat(cur) - parseFloat(buyPrice)) / parseFloat(buyPrice)) * 100;
    return Math.abs(pnlPct) < STAGNATION_FLAT_PCT;
  };

  // ── Guard 3: still shows up as A/A+ today, even if outside the top-N
  // slot count ──
  // gradeStillTop (above) only protects a position if it's within THIS
  // cycle's capacity-limited top-N slice (EXEC_TOP_N_COUNT). A position
  // ranked #4 while only the top 3 slots get bought loses that protection
  // purely due to the slot count — not because today's signal actually
  // stopped liking it. Originally this broader check only applied to
  // positions already holding for T2 (tp1_hit, no exitPrice) — but the
  // same slot-count gap applies just as much to a pre-T1 position that's
  // still genuinely recommended, just crowded out of the top-N window by
  // this cycle's ranking. Protecting it here (rather than letting it fall
  // through to Guard 1/2 alone) avoids rotating out a position the signal
  // still likes, just to make room for a marginally higher-ranked one —
  // real churn, not a real quality difference.
  const allStarredBases = new Set(allStarred.map(r => r.a.pair.replace(/[^A-Z]/g, '').replace(/USDT$/, '')));
  const stillOnFullStarredList = (base) => allStarredBases.has(base);

  // Combined: protected if it's today's actual top pick, OR still within
  // the hold window, OR currently below its own buy price (Guard 2 returns
  // null = "no opinion" when it can't evaluate, which correctly does NOT
  // protect — falls through to selling, same as previous behavior when
  // price/buyPrice data is simply unavailable).
  // ── Guard 4: profitable AND momentum still strong — protected even if
  // it fell off today's recommended list entirely ──
  // Guards 1-3 only ever ask "is this still today's recommended pick?" —
  // none of them look at the position's OWN momentum. That means a
  // profitable position whose momentum is genuinely still strong could
  // get rotated out purely because its RANK slipped (fewer bullConf
  // checks passing today, a slightly lower conv score, etc.) even though
  // nothing about its actual price action has changed. Worse, Position
  // Intelligence and Profit Intelligence BOTH already evaluated this
  // exact position earlier the same cycle (monitorPositions runs before
  // rotation) and may well have said "HOLD, momentum still good" — only
  // for rotation to sell it moments later for an unrelated reason. This
  // reuses isMomentumWeak from profit-intelligence.js directly (not a
  // re-implementation) so both systems read momentum identically — if
  // CVD/OI/breadth aren't fading and RSI hasn't rolled over, a profitable
  // position is protected here regardless of its current rank.
  const isMomentumStillStrong = (base, pos) => {
    const buyPrice = pos?.liveOrder?.fillPrice;
    const cur = (market.symbols || {})[base + 'USDT']?.price;
    if (!buyPrice || cur === undefined || cur === null) return false; // no data — no opinion, don't protect
    const pnlPct = ((parseFloat(cur) - parseFloat(buyPrice)) / parseFloat(buyPrice)) * 100;
    if (pnlPct < ROTATION_SELL_MIN_NET_PNL_PCT) return false; // only relevant for a genuinely profitable position — Guard 2 already handles flat/losing
    const symbolState = marketState?.symbols?.[base + 'USDT'];
    const r15 = parseFloat((market.symbols || {})[base + 'USDT']?.d?.r15);
    const momentum = isMomentumWeak({ symbolState, marketState, r15, lastR15: pos.lastR15 ?? null });
    return !momentum.weak;
  };

  const isProtected = (base, pos) => {
    if (gradeStillTop(base)) return true;
    if (withinMinHold(pos)) return true;
    if (stillOnFullStarredList(base)) return true;
    if (isMomentumStillStrong(base, pos)) return true;
    const atOrAboveBuy = currentlyAtOrAboveBuy(base, pos);
    if (atOrAboveBuy === false && !isStagnant(base, pos)) return true; // below buy price — protected UNLESS also stale+flat (waived above)
    return false;
  };

  const sellTargets = []; // [{ base, sym, freeQty?, pos?, key? }]

  if (effectiveTradeMode === 'live') {
    // Reconcile against the REAL exchange, not just positions.json — this is
    // what lets rotation see a coin bought manually outside the bot (or one
    // whose tracked qty drifted from reality) as a genuine open position.
    let balances = [];
    try {
      balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
    } catch (e) {
      console.log(`  ⚠️  Rotation: couldn't fetch MEXC balances (${e.message}) — falling back to tracked positions only`);
    }
    const seenBases = new Set();
    for (const bal of balances) {
      const base = bal.asset;
      if (QUOTE_ASSETS.has(base) || isNoTradeSymbol(base + 'USDT')) continue;
      const trackedEntry = Object.entries(positions).find(
        ([, p]) => p.base === base && p.assetType === 'crypto' && !p.liveOrder?.closedAt
      );
      if (isProtected(base, trackedEntry?.[1])) continue; // protected — top pick, recent buy, or currently below buy price
      seenBases.add(base);
      sellTargets.push({ base, sym: base + 'USDT', freeQty: bal.free, pos: trackedEntry?.[1], key: trackedEntry?.[0] });
    }
    // A tracked live position that didn't show up in the balance query at
    // all (already at 0 on the exchange, but positions.json still has it
    // open) still needs resolving so it doesn't sit stuck — route it through
    // closeLiveOrder below, which reports "0 balance" clearly instead of
    // leaving a ghost entry.
    for (const [key, p] of Object.entries(positions)) {
      if (p.assetType !== 'crypto' || p.liveOrder?.mode !== 'live' || p.liveOrder?.closedAt) continue;
      if (['stopped', 'tp2_hit'].includes(p.status)) continue;
      if (seenBases.has(p.base) || isProtected(p.base, p)) continue;
      sellTargets.push({ base: p.base, sym: p.base + 'USDT', freeQty: 0, pos: p, key });
    }
  } else {
    // Paper mode has no real exchange balance to reconcile against — use
    // tracked positions.json only, same as before.
    for (const [key, p] of Object.entries(positions)) {
      if (p.assetType !== 'crypto' || p.liveOrder?.mode !== 'paper' || p.liveOrder?.closedAt) continue;
      if (['stopped', 'tp2_hit'].includes(p.status)) continue;
      if (isProtected(p.base, p)) continue;
      sellTargets.push({ base: p.base, sym: p.base + 'USDT', pos: p, key });
    }
  }

  if (!sellTargets.length) return { changed, rotationCandidates };

  console.log(`  🔄  ROTATION — ${rotationCandidates.map(c => c.pair).join(', ')} qualify → selling ${sellTargets.length} position(s) first`);
  const rotationSells = [];

  for (const target of sellTargets) {
    const { base, sym, pos, key } = target;
    const sellAlerts = [];
    const wasHoldingT1 = pos?.status === 'tp1_hit' && !pos?.exitPrice;
    const mData = (market.symbols || {})[sym];
    const marketPrice = parseFloat(mData?.d?.p || pos?.entryPrice || 0);

    if (pos) {
      // Tracked position — reuse the existing safe closeLiveOrder path (handles
      // paper vs live, re-checks the real balance, records the trade-log close).
      pos.exitPrice = marketPrice;
      const closeResult = await closeLiveOrder(pos, wasHoldingT1 ? 'rotation — no longer top grade' : 'rotation', sellAlerts);
      const isLiveCrypto = pos.assetType === 'crypto' && pos.liveOrder?.mode === 'live';

      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;
        rotationSells.push({ base, skipped: true, reason: closeResult.reason });
        for (const m of sellAlerts) await sendTelegram(m);
        continue;
      }

      const finalExitPrice = pos.liveOrder?.exitFillPrice || marketPrice;
      const pnlPct = pos.entryPrice > 0
        ? parseFloat(((finalExitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2))
        : 0;

      closedOutcomes.push({
        base, pair: base + 'USDT',
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null,
        outcome: wasHoldingT1 ? 'rotation_t1_downgrade' : 'rotation', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct, closedAt: Date.now(),
      });
      rotationSells.push({ base, pnlPct, wasHoldingT1 });

      if (wasHoldingT1) {
        // No longer top-grade — remove now rather than waiting on the usual
        // TERMINAL_EVICT_MS window, so the slot/capital frees immediately.
        delete positions[key];
      } else {
        pos.status          = 'stopped'; // treated as a close
        pos.statusChangedAt = Date.now();
        pos.exitPrice       = finalExitPrice;
        pos.rotatedOut      = true;
      }
      changed = true;
      for (const m of sellAlerts) await sendTelegram(m);
    } else {
      // Untracked — a real MEXC balance with no matching positions.json entry
      // (e.g. bought manually outside the bot). Sell it directly; there's no
      // buy record in the trade journal for it since the bot never placed
      // that buy, so this can't be logged as a P&L close, only as a sell.
      try {
        const step    = await getBaseSizePrecision(sym);
        const sellQty = floorToStep(target.freeQty, step);

        // ── Dust guard — checked BEFORE the zero-balance branch below ──
        // Evaluated against the REAL freeQty, not sellQty — a tiny leftover
        // that floors to 0 sellable units still needs to be recognized as
        // dust (not "zero balance, retry forever"). Same fix as
        // closeLiveOrder in position-monitor.js.
        const estNotional = target.freeQty * marketPrice;
        if (marketPrice > 0 && target.freeQty > 0 && estNotional < MIN_SELL_NOTIONAL_USDT) {
          logAudit('mexc_sell_skipped_dust', { sym, reason: 'rotation_untracked', freeQty: target.freeQty, estNotional });
          await sendTelegram(
            `🧹 *DUST IGNORED (untracked)* — ${target.freeQty} ${base} (~$${estNotional.toFixed(4)}) is below MEXC's $${MIN_SELL_NOTIONAL_USDT} minimum sell (or its lot-size step) — leaving it on the exchange.`
          );
          rotationSells.push({ base, skipped: true, reason: 'dust_ignored' });
          continue;
        }

        if (sellQty <= 0) {
          rotationSells.push({ base, skipped: true, reason: 'zero_balance' });
          continue;
        }
        const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, sym, sellQty);
        logAudit('mexc_sell_untracked', { sym, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId });
        await sendTelegram(
          `🟢 *LIVE SELL (untracked)* — closed ${sellQty} ${base} @ $${sell.fillPrice.toFixed(6)} on MEXC\n` +
          `  _No matching bot buy record for this — likely bought manually. Sold to make room for the new A/A+ pick(s); no P&L entry in the journal._`
        );
        rotationSells.push({ base, untracked: true });
        changed = true;
      } catch (e) {
        // Fallback: MEXC itself rejected it as under-minimum even though our
        // pre-check (stale/zero marketPrice) didn't catch it — treat the same.
        if (/minimum transaction volume/i.test(e.message || '')) {
          logAudit('mexc_sell_skipped_dust', { sym, reason: 'rotation_untracked', error: e.message });
          await sendTelegram(`🧹 *DUST IGNORED (untracked)* — ${base}: MEXC rejected the sell as below its minimum notional — leaving it on the exchange.`);
          rotationSells.push({ base, skipped: true, reason: 'dust_ignored' });
          continue;
        }
        logAudit('mexc_sell_untracked_failed', { sym, error: e.message });
        await sendTelegram(`🚨 *LIVE SELL FAILED (untracked)* — ${base}: ${e.message} — CLOSE MANUALLY on MEXC.`);
        rotationSells.push({ base, skipped: true, reason: 'error' });
      }
    }
  }

  const reasonLabel = (r) => {
    if (r.reason === 'zero_balance')  return '0 balance';
    if (r.reason === 'dust_ignored')  return 'dust, below min sell';
    return r.reason;
  };
  const sellSummary = rotationSells
    .map(r => r.skipped
      ? `${r.base} SKIPPED (${reasonLabel(r)})`
      : r.untracked
        ? `${r.base} sold (untracked)`
        : `${r.base} ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}%${r.wasHoldingT1 ? ' (T1 hold, lost A/A+)' : ''}`)
    .join(', ');
  const anySkipped = rotationSells.some(r => r.skipped && r.reason !== 'dust_ignored');
  await sendTelegram(
    `🔄 *ROTATION* — ${utc}\n` +
    `  ${sellSummary}\n` +
    `  Rotating into: ${rotationCandidates.map(c => c.entry.grade + ' ' + c.pair.replace('USDT', '')).join(', ')}\n` +
    (anySkipped ? `  ⚠️ _Some sells were skipped — see alert above. That position stays tracked/open and will retry next cycle._\n` : '') +
    `  _Fresh topN buy alert — rotating positions_`
  );
  logAudit('rotation_sell', { sold: rotationSells, into: rotationCandidates.map(c => c.pair) });

  return { changed, rotationCandidates };
}

// ── 15m Supertrend Priority Execution (Priority-1 / P1) ──
// Per the "15m Supertrend Priority Execution" dev-team note: a confirmed
// closed-15m Supertrend RED→GREEN cross (detected in leaderboard-scanner.js/
// market-fetcher.js, persisted as a PENDING st15Event on the symbol's
// market-data.json entry) gets high trading priority and rotates
// the existing crypto position(s) into the new candidate — bypassing every
// STRATEGY-qualification gate (grade, conv, whale, watch count, 5m
// breakout, CVD/volume confirmation, Entry Quality Check, BUY/EARLY BUY
// signal, Top-N ranking, normal cooldown/rotation qualification).
//
// NOTE — priority ordering: this is P1, not the top priority. The 5m
// Supertrend cross (executeST5PriorityRotation, below) is P0 and runs
// FIRST each cycle (see leaderboard-decider.js call order) — per the
// dev-team doc, P0 > P1 > P2 (the normal WATCH/EARLY BUY candidate scan).
// Originally labeled "Priority-0" here before the 5m/P0 tier existed;
// left this function and its identifiers (ST15_*, st15EventId, etc.)
// unchanged to avoid an unnecessary rename churn across positions.json /
// symbol-history.json — only the priority NUMBER changed, not the code.
//
// It does NOT bypass execution-safety controls: TRADE_MODE off stays off,
// the Telegram /pause kill-switch, MEXC credentials, no-trade-symbol list,
// duplicate-holding check, live concurrency cap, or SELL-must-be-confirmed-
// before-BUY. Runs independently of, and before, the normal buy scan in
// leaderboard-decider.js — an ST event can execute on a cycle where the
// normal scan finds nothing at all.
//
// Deliberately reuses the SAME closeLiveOrder() safe-close path rotation
// already uses (position-monitor.js) rather than a second sell
// implementation, and mirrors executeAutoBuys' paper/live buy branches —
// this is the same execution machinery, just with strategy gates skipped
// and sell-then-buy sequencing enforced explicitly.
const ST15_ENABLE            = (process.env.ST15_ENABLE ?? 'true') === 'true';
const ST15_PRIORITY_USD_SIZE = parseFloat(process.env.ST15_PRIORITY_USD_SIZE || process.env.TRADE_USD_SIZE || '25');

// ── Rotation-storm controls — dev-team note "ST5 / ST15 Priority Buy &
// Multi-Alert Rotation". Shared by BOTH executeST5PriorityRotation (P0)
// and executeSTPriorityRotation/ST15 (P1) below — one repo Variable set
// controls both timeframes, since the storm the note describes was
// exactly "many independent ST rotations of either timeframe within
// minutes of each other," not a per-timeframe problem.
//
// ST_EVENT_TTL_MIN     — a PENDING event older than this is EXPIRED
//                         instead of executed (never trade a stale cross).
// ST_MAX_DISTANCE_PCT  — a cross already this far above its own ST line is
//                         REJECTED_TOO_FAR (the note's ZEC example: +5.4%
//                         above ST is a late chase, not a fresh cross).
// ST_ROTATION_COOLDOWN_MIN — after any ST5/ST15 rotation actually SELLS or
//                         BUYs something, both functions skip entirely
//                         (leaving events PENDING for next cycle) for this
//                         long — this is the "only one P0 basket/rotation
//                         executes at a time" control, implemented as a
//                         cooldown rather than a lock file, since every run
//                         is a fresh process (no in-memory lock would
//                         survive between GitHub Actions runs anyway).
// ST_EQUAL_ALLOCATE    — when multiple fresh candidates are eligible in
//                         the SAME cycle, divide the configured priority
//                         USD size across them instead of giving each one
//                         the full amount (note §1).
// ST_FAILED_SELL_QUARANTINE_MIN — once a tracked position's SELL fails
//                         with a real exchange error (not zero-balance —
//                         see the zero_balance branch below, that's a
//                         different, non-error case), it's excluded from
//                         every ST rotation's sell list for this long
//                         instead of being retried (and failing the same
//                         way) on every subsequent cross — this is what
//                         stopped the IMX SELL failing 10 times in ~20
//                         minutes in the log the note reviewed.
const ST_EVENT_TTL_MIN               = parseFloat(process.env.ST_EVENT_TTL_MIN || '20');
const ST_MAX_DISTANCE_PCT            = parseFloat(process.env.ST_MAX_DISTANCE_PCT || '3');
const ST_ROTATION_COOLDOWN_MIN       = parseFloat(process.env.ST_ROTATION_COOLDOWN_MIN || '10');
const ST_EQUAL_ALLOCATE              = (process.env.ST_EQUAL_ALLOCATE ?? 'true') === 'true';
const ST_FAILED_SELL_QUARANTINE_MIN  = parseFloat(process.env.ST_FAILED_SELL_QUARANTINE_MIN || '60');

function isSTRotationOnCooldown(tradeState) {
  const last = tradeState.lastSTRotationAt || 0;
  return (Date.now() - last) < ST_ROTATION_COOLDOWN_MIN * 60000;
}
function markSTRotationExecuted(tradeState) {
  tradeState.lastSTRotationAt = Date.now();
}
function isSellQuarantined(pos) {
  if (!pos.sellBlockedAt) return false;
  return (Date.now() - pos.sellBlockedAt) < ST_FAILED_SELL_QUARANTINE_MIN * 60000;
}

// ── Shared sizing for ST5/ST15 priority buys ──
// Mirrors executeAutoBuys' percent-mode sizing exactly (same balance
// source, same MEXC_SIZING_BUFFER_PCT buffer) so a priority buy respects
// TRADE_SIZE_PCT the same way a normal buy does, instead of always using
// a fixed dollar amount regardless of TRADE_SIZE_MODE. Called AFTER the
// rotation sells above have already completed, so the balance this reads
// (live: fresh mexcFreeBalance call; paper: loadPaperBalance(), which
// closeLiveOrder already credited with sell proceeds) reflects the
// freshly-freed USDT from selling everything else — not the pre-rotation
// balance. No market-guard sizeMult applied here, consistent with ST
// priority not consulting the market guard at all (see the STEP 1.6/1.7
// comments in leaderboard-decider.js for why).
async function computeSTPriorityUsdSize({ effectiveTradeMode, effectiveSizeMode, effectiveSizePct, fallbackUsdSize, label }) {
  if (effectiveSizeMode !== 'percent') return { totalUsd: fallbackUsdSize, balance: null };

  const balance = effectiveTradeMode === 'live'
    ? await mexcFreeBalance(MEXC_API_KEY, MEXC_API_SECRET, 'USDT')
    : loadPaperBalance();
  const SIZING_BUFFER_PCT = parseFloat(process.env.MEXC_SIZING_BUFFER_PCT || '1');
  const bufferedPct = Math.max(0, effectiveSizePct - SIZING_BUFFER_PCT);
  const totalUsd = parseFloat((balance * (bufferedPct / 100)).toFixed(2));
  console.log(`  💰  ${label} sizing: ${bufferedPct}% of ${effectiveTradeMode} balance $${balance.toFixed(2)} (${effectiveSizePct}% target − ${SIZING_BUFFER_PCT}% buffer) = $${totalUsd}`);
  return { totalUsd, balance };
}

export async function executeSTPriorityRotation({
  market, positions, tradeState, effectiveTradeMode, effectiveMaxLive,
  effectiveSizeMode = 'usd', effectiveSizePct = 100,
  utc, closedOutcomes, marketState = {},
}) {
  let changed = false;
  if (!ST15_ENABLE) return { changed };
  if (effectiveTradeMode === 'off') return { changed };       // TRADE_MODE off remains off — no exception
  if (!tradeState.tradingEnabled) return { changed };          // Telegram /pause kill-switch
  if (isSTRotationOnCooldown(tradeState)) {
    console.log(`  ⏸  ST15 rotation on cooldown (${ST_ROTATION_COOLDOWN_MIN}min since last ST5/ST15 execution) — deferring all pending events to next cycle`);
    return { changed };
  }

  const pending = Object.entries(market.symbols || {})
    .filter(([, e]) => e.assetType === 'crypto' && e.st15Event?.status === 'PENDING')
    .map(([pair, e]) => ({ pair, entry: e, event: e.st15Event }));

  if (!pending.length) return { changed };

  // Deterministic order if two symbols cross the same cycle — earliest
  // detected first (§12 acceptance test: "Two symbols cross together").
  pending.sort((x, y) => new Date(x.event.detectedAt) - new Date(y.event.detectedAt));

  // ── Freshness / chase protection (dev-team note §5) — filtered BEFORE
  // the basket size is computed, so an expired/too-far event neither
  // executes NOR shrinks everyone else's equal-allocation share. ──
  const fresh = [];
  for (const cand of pending) {
    const { event, pair } = cand;
    const ageMin = (Date.now() - new Date(event.detectedAt).getTime()) / 60000;
    if (ageMin > ST_EVENT_TTL_MIN) {
      event.status = 'EXPIRED';
      logAudit('st15_expired', { pair, id: event.id, ageMin: ageMin.toFixed(1), ttlMin: ST_EVENT_TTL_MIN });
      continue;
    }
    if (event.distancePct != null && event.distancePct > ST_MAX_DISTANCE_PCT) {
      event.status = 'REJECTED_TOO_FAR';
      logAudit('st15_rejected_too_far', { pair, id: event.id, distancePct: event.distancePct, maxPct: ST_MAX_DISTANCE_PCT });
      continue;
    }
    fresh.push(cand);
  }
  if (!fresh.length) return { changed };

  // ── Equal allocation (dev-team note §1) — basket size is the fresh-
  // candidate count determined above, BEFORE any per-symbol NOOP/no-trade
  // rejection below (§2: "determine the final candidate set first,
  // calculate equal allocation second" — this repo's simpler reading of
  // that rule stops at "fresh and not obviously invalid," rather than
  // pre-resolving already-held/no-trade too, to avoid a second full pass
  // over live exchange state before any order is placed). A candidate that
  // turns out NOOP/no-trade simply leaves its share unused rather than
  // redistributing it — matches §8's "no automatic redistribution" default. ──
  const basketSize = ST_EQUAL_ALLOCATE ? fresh.length : 1;
  if (fresh.length > 1) {
    console.log(`  🧺  ST15 basket: ${fresh.length} fresh candidate(s) this cycle (${fresh.map(c => c.pair).join(', ')})${ST_EQUAL_ALLOCATE ? ` — equal allocation ÷${basketSize}` : ''}`);
  }

  for (const { pair, entry, event } of fresh) {
    const base = pair.replace('USDT', '').replace(/\.\w+$/, '');
    const sym  = buildSymKey(pair);

    // Mark EXECUTING immediately — narrows (does not eliminate; this repo
    // relies on the Cloudflare Worker's overlap-prevention for the rest,
    // same as every other job here) the window where a second overlapping
    // run could re-pick up the same PENDING event.
    event.status = 'EXECUTING';

    if (isNoTradeSymbol(pair)) {
      event.status = 'SKIPPED_NO_TRADE';
      logAudit('st15_skipped', { pair, id: event.id, reason: 'no_trade_symbol' });
      continue;
    }
    if (effectiveTradeMode === 'live' && (!MEXC_API_KEY || !MEXC_API_SECRET)) {
      event.status = 'ERROR';
      logAudit('st15_error', { pair, id: event.id, reason: 'missing_api_credentials' });
      await sendTelegram(`🚨 *ST15 CROSS — ${base}* — MEXC API credentials not configured. Event marked ERROR, will not retry automatically.`);
      continue;
    }

    // Already held → no-op per §6 of the dev note: validate and mark handled.
    const existingKey = Object.keys(positions).find(k =>
      positions[k].base === base && positions[k].assetType === 'crypto'
      && !positions[k].liveOrder?.closedAt && !['stopped', 'tp2_hit'].includes(positions[k].status)
    );
    if (existingKey) {
      event.status = 'NOOP_ALREADY_HELD';
      logAudit('st15_noop', { pair, id: event.id, reason: 'already_held' });
      await sendTelegram(`ℹ️ *ST15 CROSS — ${base}* — already held, no rotation needed. Event marked handled.`);
      continue;
    }

    // ── RSI-overextension gate ──
    // ST15 bypasses every OTHER strategy-qualification check by design
    // (grade, conviction, whale, breakout confirmation, etc. — see the
    // dev-team note this whole path is built from) — but that meant it
    // was buying purely on the Supertrend flip with literally no check
    // for whether the move was already exhausted by the time the cross
    // confirmed. Trade-log review (46 closed ST5/ST15 trades) showed
    // stop-hit losses (avg -1.36%) running full-size against
    // rotation-capped wins (avg +0.65%) that almost never reach T1/T2 —
    // net roughly breakeven-to-negative before fees. Reusing
    // buy-intelligence.js's existing RSI check (already proven on the
    // normal buy path) closes the most direct hole: don't buy a cross
    // that's already deep into overbought RSI on the SAME r15/r1h data
    // this cycle's market-fetcher already computed for this symbol —
    // no extra API calls, no added latency to the priority path.
    const st15Ext = calcEntryExtension(entry?.d?.r15, entry?.d?.r1h);
    if (st15Ext.penalty > 0) {
      event.status = 'SKIPPED_OVEREXTENDED';
      logAudit('st15_skipped_overextended', { pair, id: event.id, r15: entry?.d?.r15, r1h: entry?.d?.r1h, reason: st15Ext.reason });
      await sendTelegram(`🚫 *ST15 CROSS — ${base}* — skipped, already overextended (${st15Ext.reason}). Event marked handled, no positions touched.`);
      continue;
    }

    // ── Falling-knife / ATR-exhaustion gate ──
    // RSI overextension above catches a slow grind into overbought on
    // 15m/1h — it says nothing about the cross itself already being a
    // blown 5m/15m move (Cross distance already +1-2%+ by the time the
    // candle closed and this event fired). st-timing-engine.js's
    // checkFallingKnife/checkExhaustedEntry were built for exactly this
    // (ATR-normalized distance zones + ST5/ST15 direction/slope) but were
    // originally wired only into the P2 engine (leaderboard-decider.js) —
    // P0/P1 bought purely on the flip with no exhaustion check at all.
    // Only the HARD conditions block here (BEAR/BEAR knife, strongly
    // negative ST5 slope, signal-evaluator's own FALLING KNIFE tag, or an
    // EXHAUSTED ATR zone) — WAIT/WAIT_RETEST-style softer states are
    // strategy-qualification concepts that ST15/ST5 priority is meant to
    // bypass by design; this only blocks the "buying the exhaustion of a
    // move that's already over" case the trade log showed.
    if (entry?.supertrend5m && entry?.supertrend15m) {
      const st15Knife = checkFallingKnife(entry, entry.supertrend5m, entry.supertrend15m);
      if (st15Knife.isFallingKnife) {
        event.status = 'SKIPPED_FALLING_KNIFE';
        logAudit('st15_skipped_falling_knife', { pair, id: event.id, reasons: st15Knife.reasons });
        await sendTelegram(`🔪 *ST15 CROSS — ${base}* — skipped, falling knife (${st15Knife.reasons.join(' · ')}). Event marked handled, no positions touched.`);
        continue;
      }
      // Judge exhaustion against the frozen-at-cross snapshot, not the
      // live re-fetched entry — checkExhaustedEntry used to see whatever
      // distanceATR the NEXT fetch cycle produced, several minutes after
      // the actual cross, penalizing entries for drift that happened
      // AFTER the signal (see the comment in market-fetcher.js's
      // buildST15Event). Falls back to the live entry if an older event
      // (pre-dating this change) has no frozen snapshot.
      const st15ExhaustedSrc  = event.st5AtCross  || entry.supertrend5m;
      const st15ExhaustedSrc2 = event.st15AtCross || entry.supertrend15m;
      const st15Exhausted = checkExhaustedEntry(st15ExhaustedSrc, st15ExhaustedSrc2, {
        triggerStatus: entry?.triggerStatus ?? null,
        regime: marketState?.marketRegime ?? null,
        breadthScore: marketState?.breadth?.score ?? null,
      });
      if (st15Exhausted.blocked) {
        event.status = 'SKIPPED_EXHAUSTED';
        logAudit('st15_skipped_exhausted', { pair, id: event.id, reason: st15Exhausted.reason });
        await sendTelegram(`📉 *ST15 CROSS — ${base}* — skipped, exhausted entry (${st15Exhausted.reason}). Event marked handled, no positions touched.`);
        continue;
      }
      // waitRetest (incl. EXHAUSTED as of the 29 Aug 2026 ATR-balance
      // tuning — see st-timing-engine.js) is NOT safe to silently fall
      // through on here: P0/P1 is designed to bypass soft WAIT states and
      // buy on the raw cross, which is exactly what reopens the RENDER/
      // SUI/TAO trap for an entry that's still too extended. Re-check
      // against the LIVE entry (the frozen-at-cross snapshot only carries
      // {distanceATR, extensionZone} and never gains a retest flag, so
      // waiting on it would never resolve) and requeue rather than buy or
      // discard — picked back up next cycle, naturally expired by
      // ST_EVENT_TTL_MIN if no retest/cooldown arrives in time.
      if (st15Exhausted.waitRetest) {
        const st15LiveCheck = checkExhaustedEntry(entry.supertrend5m, entry.supertrend15m, {
          triggerStatus: entry?.triggerStatus ?? null,
          regime: marketState?.marketRegime ?? null,
          breadthScore: marketState?.breadth?.score ?? null,
        });
        if (st15LiveCheck.waitRetest) {
          event.status = 'PENDING';
          logAudit('st15_wait_retest', { pair, id: event.id, reason: st15LiveCheck.reason });
          continue;
        }
        logAudit('st15_retest_confirmed', { pair, id: event.id, reason: st15LiveCheck.reason });
      }
      if (st15Exhausted.overrideUsed) {
        logAudit('st15_exhausted_override', { pair, id: event.id, reason: st15Exhausted.reason });
        await sendTelegram(`⚡ *ST15 CROSS — ${base}* — EXHAUSTED-zone hard block bypassed (${st15Exhausted.reason}).`);
      }
    }

    console.log(`  🟣  ST15_CROSS_UP — ${pair} [${event.id}] — Priority-0 execution starting`);
    logAudit('st15_event_consumed', { pair, id: event.id, candleTime: event.candleTime });
    await sendTelegram(
      `🟣 *HIGH PRIORITY — 15m SUPERTREND CROSS UP* — ${base}USDT — ${utc}\n` +
      `  Price: $${event.close}  15m Supertrend: $${event.supertrend}  Cross distance: +${event.distancePct}%\n` +
      `  Candle: ${event.candleTime}\n` +
      `  Event: \`${event.id}\`\n` +
      `  🔓 Normal BUY conditions bypassed — safety checks in progress…`
    );

    // ── SELL every other currently-held crypto position that's currently
    // ABOVE its own buy price (tracked AND, in live mode, any untracked
    // real MEXC balance — untracked has no buy-price record to compare
    // against, so it's swept unconditionally same as before) — never the
    // ST target itself.
    //
    // ST15 is Priority-0 for STRATEGY qualification (grade/conv/cooldown/
    // momentum/etc. — see the big comment above this function), but that
    // was never meant to force realizing a loss on an unrelated held
    // position just to fund this buy. That's the exact same "never let
    // rotation lock in a loss on a position that hasn't hit its own stop"
    // principle the normal executeRotation() applies via its Guard 2 above
    // — simpler here since ST15 doesn't need the other rotation guards
    // (min-hold, momentum, stagnation), just this one. ST15_MIN_PROFIT_PCT
    // reads the SAME ROTATION_MIN_PROFIT_PCT (default 0.2%) normal
    // rotation and ST5 use — one repo Variable controls the minimum-profit
    // threshold everywhere, no separate ST15_MIN_PROFIT_PCT Variable.
    //
    // A protected (still-underwater) position is simply left alone — if
    // that leaves no live-trade capacity for the ST buy, the concurrency-
    // cap check further down reports it and skips the buy this cycle
    // rather than forcing a sell.
    const sellAlerts = [];
    let sellFailed = false;
    const protectedPositions = [];

    const ST15_MIN_PROFIT_PCT = parseFloat(process.env.ROTATION_MIN_PROFIT_PCT || '0.2');
    // Trade-log review (46 closed ST5/ST15 trades) showed rotation exits
    // averaging only +0.65% — barely above the 0.2% floor — because a
    // priority-origin position gets harvested by the very NEXT cross the
    // instant it clears that floor, never getting a real shot at T1/T2,
    // while stop-hit losses ran the full -1.36% every time. Positions
    // that themselves came from an ST5/ST15 priority buy now need a
    // higher bar (ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT, default 1%)
    // before another priority event is allowed to rotate them out —
    // everything else (normal topN-sourced holdings) keeps the original
    // 0.2% floor unchanged.
    const ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT = parseFloat(process.env.ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT || '1');
    const isAboveBuyPrice = (pos, curPrice) => {
      const buyPrice = pos?.liveOrder?.fillPrice;
      if (!buyPrice || curPrice === undefined || curPrice === null || isNaN(curPrice)) return false; // no data — don't sell blind
      const minPct = ['ST5 PRIORITY', 'ST15 PRIORITY'].includes(pos?.setup) ? ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT : ST15_MIN_PROFIT_PCT;
      return parseFloat(curPrice) > parseFloat(buyPrice) * (1 + minPct / 100);
    };

    const trackedToSell = [];
    for (const [key, p] of Object.entries(positions)) {
      const eligible = p.assetType === 'crypto' && p.base !== base
        && p.liveOrder?.mode === effectiveTradeMode && !p.liveOrder?.closedAt
        && !['stopped', 'tp2_hit'].includes(p.status);
      if (!eligible) continue;
      if (isSellQuarantined(p)) {
        protectedPositions.push(`${p.base} (quarantined)`);
        logAudit('st15_rotation_sell_quarantined', { base: p.base, eventId: event.id, sellBlockedAt: p.sellBlockedAt });
        continue;
      }
      // Live MEXC price fetched RIGHT NOW, not market.symbols[...].price
      // (Binance-sourced, up to one ~5min market-fetcher cycle stale) —
      // see the mexcGetLivePrice comment in mexc-client.js for why this
      // specific gap matters here: it's the same exchange and same
      // moment the actual SELL below will use, so this guard can't pass
      // on a snapshot the real fill has already drifted below.
      let curPrice = null;
      if (effectiveTradeMode === 'live') {
        try { curPrice = await mexcGetLivePrice(p.base + 'USDT'); }
        catch (e) { console.log(`  ⚠️  ST15: live price fetch failed for ${p.base} (${e.message}) — falling back to market-data.json snapshot`); }
      }
      if (curPrice == null) curPrice = parseFloat((market.symbols || {})[p.base + 'USDT']?.price);
      if (!isAboveBuyPrice(p, curPrice)) {
        protectedPositions.push(p.base);
        logAudit('st15_rotation_sell_protected', { base: p.base, eventId: event.id, buyPrice: p.liveOrder?.fillPrice, curPrice });
        continue;
      }
      trackedToSell.push([key, p]);
    }

    for (const [key, pos] of trackedToSell) {
      const mData       = (market.symbols || {})[pos.base + 'USDT'];
      const marketPrice = parseFloat(mData?.d?.p || pos.entryPrice || 0);
      pos.exitPrice = marketPrice;
      const closeResult = await closeLiveOrder(pos, `ST15 priority rotation — ${event.id}`, sellAlerts, effectiveTradeMode);
      const isLiveCrypto = pos.liveOrder?.mode === 'live';

      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;

        // ── zero_balance is NOT a sell failure — it means there was
        // nothing real to sell in the first place ──
        // A tracked position whose real exchange balance already reads 0
        // (sold manually outside the bot, or a prior partial close that
        // didn't fully update tracking — same root cause
        // monitorPositions' staleZeroBalanceStrikes guards against on the
        // normal monitor cycle) must not block this buy. ST priority
        // already treats "sell everything else" as unconditional, so
        // there's no reason to wait out a multi-cycle strike counter here
        // the way the normal path does — close the stale tracking entry
        // immediately (recording it in the trade log so the Journal still
        // shows it closed, not just vanishing) and continue to the BUY.
        if (closeResult.reason === 'zero_balance') {
          console.log(`  ℹ️  ST15 rotation — ${pos.base} tracked but exchange balance is 0 (stale entry) — closing tracking, NOT blocking the ${base} BUY`);
          pos.status              = 'stopped';
          pos.statusChangedAt     = Date.now();
          pos.liveOrder.closedAt      = Date.now();
          pos.liveOrder.exitFillPrice = pos.liveOrder.fillPrice; // real exit price unknown — not a bot-tracked sell
          recordTradeClose(pos, `st15_priority_rotation_stale_zero_balance — ${event.id}`, { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
          await pushTradeLogToGitHub(loadTradeLog());
          logAudit('st15_stale_position_cleared', { base: pos.base, eventId: event.id });
          await sendTelegram(`🔍 *ST15 ROTATION — STALE POSITION CLOSED* — ${pos.base}: exchange balance already 0 (sold outside the bot) — closed tracking, no sell needed. Not blocking the ${base} buy.`);
          changed = true;
          continue; // does NOT set sellFailed — buy proceeds
        }

        sellFailed = true;
        pos.sellBlockedAt = Date.now();
        pos.sellBlockedReason = closeResult.reason || 'unknown';
        logAudit('st15_sell_quarantine_set', { base: pos.base, eventId: event.id, reason: pos.sellBlockedReason, quarantineMin: ST_FAILED_SELL_QUARANTINE_MIN });
        console.log(`  🛑  ST15 rotation SELL failed for ${pos.base} (${closeResult.reason}) — aborting BUY for ${base}, quarantining ${pos.base} for ${ST_FAILED_SELL_QUARANTINE_MIN}min`);
        continue;
      }
      const finalExitPrice = pos.liveOrder?.exitFillPrice || marketPrice;
      const pnlPct = pos.entryPrice > 0
        ? parseFloat(((finalExitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)) : 0;

      closedOutcomes.push({
        base: pos.base, pair: pos.base + 'USDT',
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null,
        outcome: 'st15_priority_rotation', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct, closedAt: Date.now(),
      });
      pos.status          = 'stopped';
      pos.statusChangedAt = Date.now();
      pos.exitPrice       = finalExitPrice;
      pos.rotatedOut      = true;
      changed = true;
    }

    // Live mode only — sweep any REAL MEXC balance with no positions.json
    // entry at all (bought manually outside the bot), same as normal
    // rotation's untracked branch, so it can't silently block freeing
    // balance for the ST buy below.
    if (effectiveTradeMode === 'live' && !sellFailed) {
      let balances = [];
      try { balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET); }
      catch (e) { console.log(`  ⚠️  ST15: couldn't fetch MEXC balances (${e.message}) — skipping untracked sweep`); }

      for (const bal of balances) {
        const balBase = bal.asset;
        if (balBase === base || QUOTE_ASSETS.has(balBase) || isNoTradeSymbol(balBase + 'USDT')) continue;
        const alreadyTracked = Object.values(positions).some(p => p.base === balBase && p.assetType === 'crypto' && !p.liveOrder?.closedAt);
        if (alreadyTracked) continue; // handled by the tracked loop above

        const untrackedSym = balBase + 'USDT';
        const mPrice = parseFloat((market.symbols || {})[untrackedSym]?.d?.p || 0);
        try {
          const step    = await getBaseSizePrecision(untrackedSym);
          const sellQty = floorToStep(bal.free, step);
          const estNotional = bal.free * mPrice;
          if (mPrice > 0 && bal.free > 0 && estNotional < MIN_SELL_NOTIONAL_USDT) {
            logAudit('st15_sell_skipped_dust', { sym: untrackedSym, reason: 'st15_priority_untracked', freeQty: bal.free, estNotional });
            continue; // dust — leave on exchange, doesn't block the buy
          }
          if (sellQty <= 0) continue;
          const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, untrackedSym, sellQty);
          logAudit('st15_sell_untracked', { sym: untrackedSym, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId, eventId: event.id });
          await sendTelegram(`🟢 *ST15 ROTATION SELL (untracked)* — closed ${sellQty} ${balBase} @ $${sell.fillPrice.toFixed(6)} on MEXC to fund the ${base} priority buy.`);
          changed = true;
        } catch (e) {
          if (/minimum transaction volume/i.test(e.message || '')) {
            logAudit('st15_sell_skipped_dust', { sym: untrackedSym, reason: 'st15_priority_untracked', error: e.message });
            continue;
          }
          logAudit('st15_sell_untracked_failed', { sym: untrackedSym, error: e.message, eventId: event.id });
          await sendTelegram(`🚨 *ST15 ROTATION SELL FAILED (untracked)* — ${balBase}: ${e.message} — CLOSE MANUALLY on MEXC. ${base} priority BUY continuing regardless (this balance wasn't required for it).`);
        }
      }
    }

    for (const m of sellAlerts) await sendTelegram(m);

    if (sellFailed) {
      event.status = 'SELL_FAILED';
      logAudit('st15_sell_failed', { pair, id: event.id });
      await sendTelegram(`🚨 *ST15 CROSS — SELL FAILED* — ${base}: could not confirm sale of an existing position — BUY ABORTED. Event left for manual review, will not retry automatically.`);
      continue; // never buy after an unconfirmed sell
    }

    // ── Live concurrency cap — still an account/infra-level control, same
    // class as balance/lot-size, not a strategy gate the note lists as
    // bypassed. Selling everything above should already have freed a slot;
    // this is a fallback in case a sell above was legitimately skipped
    // (e.g. dust) rather than failed. ──
    if (effectiveTradeMode === 'live' && countLiveOpenPositions(positions) >= effectiveMaxLive) {
      event.status = 'BLOCKED_MAX_LIVE';
      logAudit('st15_blocked_max_live', { pair, id: event.id, protectedPositions });
      // Was never engaging the rotation cooldown here (only `if (changed)`
      // further down did) — a starved event just re-fired and re-alerted
      // on every single decide cycle with no backoff until a slot freed up
      // or the event's own TTL expired. Marking it here doesn't touch
      // `changed`, so it still won't trigger a spurious savePositions/
      // GitHub push — it only starts the ST_ROTATION_COOLDOWN_MIN clock.
      markSTRotationExecuted(tradeState);
      await sendTelegram(
        `🚫 *ST15 CROSS — ${base}* — still at ${effectiveMaxLive}/${effectiveMaxLive} live trade cap after rotation sells — BUY skipped this cycle.\n` +
        (protectedPositions.length
          ? `  🛡 _${protectedPositions.join(', ')} kept — currently at/below buy price, not sold at a loss. Will retry once a slot frees up._`
          : '')
      );
      continue;
    }

    // ── BUY the ST candidate ──
    const now   = Date.now();
    const shock = entry?.d?.shock ?? 1;

    const { totalUsd: st15TotalUsd } = await computeSTPriorityUsdSize({
      effectiveTradeMode, effectiveSizeMode, effectiveSizePct,
      fallbackUsdSize: ST15_PRIORITY_USD_SIZE, label: 'ST15 priority',
    });
    const st15UsdSize = parseFloat((st15TotalUsd / basketSize).toFixed(2));
    if (st15UsdSize <= 0) {
      event.status = 'BLOCKED_ZERO_BALANCE';
      logAudit('st15_blocked_zero_balance', { pair, id: event.id });
      // Same cooldown gap as BLOCKED_MAX_LIVE above — a thin/near-zero
      // live balance would otherwise get re-checked and re-alerted on
      // every decide cycle until it either frees up or the event expires
      // via ST_EVENT_TTL_MIN. Doesn't touch `changed`.
      markSTRotationExecuted(tradeState);
      await sendTelegram(`🚫 *ST15 CROSS — ${base}* — $0 available after rotation sells (percent sizing) — BUY skipped this cycle.`);
      continue;
    }

    positions[sym] = {
      sym, base, assetType: 'crypto', exchangePrefix: entry.exchangePrefix || 'BINANCE', session: '24/7',
      setup: 'ST15 PRIORITY', dir: 'bull',
      alertedAt: now, holdLockUntil: now, // no hold-lock delay for a priority execution
      entryPrice: 0, stop: 0, t1: 0, t2: 0, // resynced to the real fill just below
      score: entry.conv ?? null, spikeScore: shock,
      exitAlertedAt: null, tier1AlertedAt: null,
      status: 'watching',
      source: 'st15_priority_v1',
      scoreSource: 'st15_cross',
      st15EventId: event.id,
    };

    if (effectiveTradeMode === 'paper') {
      const fillPrice = parseFloat(entry?.d?.p || event.close || 0);
      const qty        = fillPrice > 0 ? st15UsdSize / fillPrice : 0;
      positions[sym].liveOrder = { mode: 'paper', buyAt: now, usdSize: st15UsdSize, qty, fillPrice, buyOrderId: `PAPER_ST15_${now}` };
      const lvl = recalcLevelsFromFill(fillPrice, shock);
      if (lvl) { positions[sym].entryPrice = fillPrice; positions[sym].stop = lvl.stop; positions[sym].t1 = lvl.t1; positions[sym].t2 = lvl.t2; }
      positions[sym].entrySnapshot      = buildEntrySnapshot(entry || {}, {});
      positions[sym].entryTriggerStatus = entry.triggerStatus ?? null;
      positions[sym].entryStateAtBuy    = 'ST15_CROSS_UP';
      logAudit('st15_paper_buy', { sym, id: event.id, usdSize: st15UsdSize, fillPrice });
      recordTradeOpen(positions[sym], { mode: 'paper', orderId: positions[sym].liveOrder.buyOrderId, qty, fillPrice, usdSize: st15UsdSize });
      await pushTradeLogToGitHub(loadTradeLog());
      if (effectiveSizeMode === 'percent') adjustPaperBalance(-st15UsdSize);
      changed = true;
      event.status = 'EXECUTED';
      await sendTelegram(
        `📝 *ST15 PRIORITY PAPER BUY* — ${base} $${st15UsdSize} USDT @ ~$${fillPrice.toFixed(6)}\n` +
        `  Event \`${event.id}\` marked EXECUTED.\n  _Paper mode — no real order placed._` +
        (protectedPositions.length ? `\n  🛡 _${protectedPositions.join(', ')} kept — at/below buy price, not sold at a loss._` : '')
      );
    } else {
      console.log(`  🟣  ST15 PRIORITY LIVE BUY — ${pair} $${st15UsdSize} USDT via MEXC...`);
      try {
        // NOTE: MEXC's REST API wants the bare pair ("TAOUSDT"), not the
        // TradingView-style prefixed `sym` ("BINANCE:TAOUSDT") used as the
        // internal positions[] tracking key — passing `sym` here caused
        // every ST15 live buy to fail with "Invalid symbol" (HTTP 400).
        const buy = await mexcMarketBuy(MEXC_API_KEY, MEXC_API_SECRET, pair, st15UsdSize);
        positions[sym].liveOrder = {
          mode: 'live', buyAt: now, usdSize: st15UsdSize,
          qty: buy.executedQty, fillPrice: buy.fillPrice, buyOrderId: buy.orderId, qtyEstimated: buy.estimated || false,
        };
        const lvl = recalcLevelsFromFill(buy.fillPrice, shock);
        if (lvl) { positions[sym].entryPrice = buy.fillPrice; positions[sym].stop = lvl.stop; positions[sym].t1 = lvl.t1; positions[sym].t2 = lvl.t2; }
        positions[sym].entrySnapshot      = buildEntrySnapshot(entry || {}, {});
        positions[sym].entryTriggerStatus = entry.triggerStatus ?? null;
        positions[sym].entryStateAtBuy    = 'ST15_CROSS_UP';
        logAudit('st15_live_buy', { sym, id: event.id, usdSize: st15UsdSize, qty: buy.executedQty, fillPrice: buy.fillPrice, orderId: buy.orderId });
        recordTradeOpen(positions[sym], { mode: 'live', orderId: buy.orderId, qty: buy.executedQty, fillPrice: buy.fillPrice, usdSize: st15UsdSize });
        await pushTradeLogToGitHub(loadTradeLog());
        changed = true;
        event.status = 'EXECUTED';
        await sendTelegram(
          `⚡ *ST15 PRIORITY LIVE BUY* — ${base} — ${utc}\n` +
          `  MEXC MARKET BUY: ${buy.executedQty}${buy.estimated ? ' (estimated)' : ''} @ $${buy.fillPrice.toFixed(6)}\n` +
          `  Size: $${st15UsdSize} USDT  Order ID: \`${buy.orderId}\`\n` +
          `  Event \`${event.id}\` marked EXECUTED.\n` +
          `  🛡 Watched by the normal stop/T1/T2 monitor from here on.\n` +
          (protectedPositions.length ? `  🛡 _${protectedPositions.join(', ')} kept — at/below buy price, not sold at a loss._\n` : '') +
          `  _Send /pause to halt further auto-buys_`
        );
      } catch (e) {
        delete positions[sym]; // no phantom tracking entry — mirrors executeAutoBuys' live-buy-failed cleanup
        event.status = 'BUY_FAILED';
        logAudit('st15_live_buy_failed', { sym, id: event.id, error: e.message });
        await sendTelegram(
          `🚨 *ST15 PRIORITY BUY FAILED* — ${base}: ${e.message}\n` +
          `  Rotation SELL already completed — you may be holding extra USDT with no new position.\n` +
          `  Event marked BUY_FAILED, will not retry automatically. Check MEXC manually.`
        );
      }
    }
  }

  if (changed) markSTRotationExecuted(tradeState);
  return { changed };
}

// ── 5m Supertrend Priority Execution (Priority-0 / P0) ──
// Same mechanism as executeSTPriorityRotation (ST15/P1) above, one
// timeframe down — a fresh 5m Supertrend RED→GREEN cross
// (leaderboard-scanner.js/market-fetcher.js: d.supertrend5m/st5Event).
// Per the dev-team doc this is the HIGHEST priority buy path: P0 > P1 >
// P2. leaderboard-decider.js calls this BEFORE executeSTPriorityRotation
// (ST15) each cycle, so a symbol with both a P0 and a P1 event pending
// in the same cycle gets bought via P0 first; the P1 pass then sees an
// existing position for that symbol and marks its own event
// NOOP_ALREADY_HELD rather than attempting a second buy.
//
// Same execution machinery and same safety-control set as ST15 (TRADE_MODE
// off stays off, /pause kill-switch, MEXC credentials, no-trade-symbol
// list, duplicate-holding check, live concurrency cap, SELL-must-be-
// confirmed-before-BUY) — only the STRATEGY-qualification bypass and the
// timeframe differ.
const ST5_ENABLE            = (process.env.ST5_ENABLE ?? 'true') === 'true';
const ST5_PRIORITY_USD_SIZE = parseFloat(process.env.ST5_PRIORITY_USD_SIZE || process.env.TRADE_USD_SIZE || '25');

export async function executeST5PriorityRotation({
  market, positions, tradeState, effectiveTradeMode, effectiveMaxLive,
  effectiveSizeMode = 'usd', effectiveSizePct = 100,
  utc, closedOutcomes, marketState = {},
}) {
  let changed = false;
  if (!ST5_ENABLE) return { changed };
  if (effectiveTradeMode === 'off') return { changed };       // TRADE_MODE off remains off — no exception
  if (!tradeState.tradingEnabled) return { changed };          // Telegram /pause kill-switch
  if (isSTRotationOnCooldown(tradeState)) {
    console.log(`  ⏸  ST5 rotation on cooldown (${ST_ROTATION_COOLDOWN_MIN}min since last ST5/ST15 execution) — deferring all pending events to next cycle`);
    return { changed };
  }

  const pending = Object.entries(market.symbols || {})
    .filter(([, e]) => e.assetType === 'crypto' && e.st5Event?.status === 'PENDING')
    .map(([pair, e]) => ({ pair, entry: e, event: e.st5Event }));

  if (!pending.length) return { changed };

  // Deterministic order if two symbols cross the same cycle — earliest
  // detected first (§12 acceptance test: "Two symbols cross together").
  pending.sort((x, y) => new Date(x.event.detectedAt) - new Date(y.event.detectedAt));

  // ── Freshness / chase protection (dev-team note §5) — filtered BEFORE
  // the basket size is computed, so an expired/too-far event neither
  // executes NOR shrinks everyone else's equal-allocation share. ──
  const fresh = [];
  for (const cand of pending) {
    const { event, pair } = cand;
    const ageMin = (Date.now() - new Date(event.detectedAt).getTime()) / 60000;
    if (ageMin > ST_EVENT_TTL_MIN) {
      event.status = 'EXPIRED';
      logAudit('st5_expired', { pair, id: event.id, ageMin: ageMin.toFixed(1), ttlMin: ST_EVENT_TTL_MIN });
      continue;
    }
    if (event.distancePct != null && event.distancePct > ST_MAX_DISTANCE_PCT) {
      event.status = 'REJECTED_TOO_FAR';
      logAudit('st5_rejected_too_far', { pair, id: event.id, distancePct: event.distancePct, maxPct: ST_MAX_DISTANCE_PCT });
      continue;
    }
    fresh.push(cand);
  }
  if (!fresh.length) return { changed };

  // ── Equal allocation (dev-team note §1) — see the identical comment in
  // executeSTPriorityRotation (ST15) above; same rule, same simplification. ──
  const basketSize = ST_EQUAL_ALLOCATE ? fresh.length : 1;
  if (fresh.length > 1) {
    console.log(`  🧺  ST5 basket: ${fresh.length} fresh candidate(s) this cycle (${fresh.map(c => c.pair).join(', ')})${ST_EQUAL_ALLOCATE ? ` — equal allocation ÷${basketSize}` : ''}`);
  }

  for (const { pair, entry, event } of fresh) {
    const base = pair.replace('USDT', '').replace(/\.\w+$/, '');
    const sym  = buildSymKey(pair);

    // Mark EXECUTING immediately — narrows (does not eliminate; this repo
    // relies on the Cloudflare Worker's overlap-prevention for the rest,
    // same as every other job here) the window where a second overlapping
    // run could re-pick up the same PENDING event.
    event.status = 'EXECUTING';

    if (isNoTradeSymbol(pair)) {
      event.status = 'SKIPPED_NO_TRADE';
      logAudit('st5_skipped', { pair, id: event.id, reason: 'no_trade_symbol' });
      continue;
    }
    if (effectiveTradeMode === 'live' && (!MEXC_API_KEY || !MEXC_API_SECRET)) {
      event.status = 'ERROR';
      logAudit('st5_error', { pair, id: event.id, reason: 'missing_api_credentials' });
      await sendTelegram(`🚨 *ST5 CROSS — ${base}* — MEXC API credentials not configured. Event marked ERROR, will not retry automatically.`);
      continue;
    }

    // Already held → no-op per §6 of the dev note: validate and mark handled.
    const existingKey = Object.keys(positions).find(k =>
      positions[k].base === base && positions[k].assetType === 'crypto'
      && !positions[k].liveOrder?.closedAt && !['stopped', 'tp2_hit'].includes(positions[k].status)
    );
    if (existingKey) {
      event.status = 'NOOP_ALREADY_HELD';
      logAudit('st5_noop', { pair, id: event.id, reason: 'already_held' });
      await sendTelegram(`ℹ️ *ST5 CROSS — ${base}* — already held, no rotation needed. Event marked handled.`);
      continue;
    }

    // ── RSI-overextension gate — see the matching ST15 comment above for
    // the full trade-log rationale (46 closed trades review). ──
    const st5Ext = calcEntryExtension(entry?.d?.r15, entry?.d?.r1h);
    if (st5Ext.penalty > 0) {
      event.status = 'SKIPPED_OVEREXTENDED';
      logAudit('st5_skipped_overextended', { pair, id: event.id, r15: entry?.d?.r15, r1h: entry?.d?.r1h, reason: st5Ext.reason });
      await sendTelegram(`🚫 *ST5 CROSS — ${base}* — skipped, already overextended (${st5Ext.reason}). Event marked handled, no positions touched.`);
      continue;
    }

    // ── Falling-knife / ATR-exhaustion gate — see the matching ST15 comment
    // above for the full rationale. Same hard-conditions-only scope: this
    // is the exact pattern from the RENDER/SUI/TAO trap (all three P0 buys
    // fired on an already-extended 5m cross distance with no exhaustion
    // check at all). ──
    if (entry?.supertrend5m && entry?.supertrend15m) {
      const st5Knife = checkFallingKnife(entry, entry.supertrend5m, entry.supertrend15m);
      if (st5Knife.isFallingKnife) {
        event.status = 'SKIPPED_FALLING_KNIFE';
        logAudit('st5_skipped_falling_knife', { pair, id: event.id, reasons: st5Knife.reasons });
        await sendTelegram(`🔪 *ST5 CROSS — ${base}* — skipped, falling knife (${st5Knife.reasons.join(' · ')}). Event marked handled, no positions touched.`);
        continue;
      }
      // Judge exhaustion against the frozen-at-cross snapshot, not the
      // live re-fetched entry — see the matching comment in the ST15
      // block above / market-fetcher.js's buildST5Event for the full
      // rationale. Falls back to the live entry if an older event
      // (pre-dating this change) has no frozen snapshot.
      const st5ExhaustedSrc  = event.st5AtCross  || entry.supertrend5m;
      const st5ExhaustedSrc2 = event.st15AtCross || entry.supertrend15m;
      const st5Exhausted = checkExhaustedEntry(st5ExhaustedSrc, st5ExhaustedSrc2, {
        triggerStatus: entry?.triggerStatus ?? null,
        regime: marketState?.marketRegime ?? null,
        breadthScore: marketState?.breadth?.score ?? null,
      });
      if (st5Exhausted.blocked) {
        event.status = 'SKIPPED_EXHAUSTED';
        logAudit('st5_skipped_exhausted', { pair, id: event.id, reason: st5Exhausted.reason });
        await sendTelegram(`📉 *ST5 CROSS — ${base}* — skipped, exhausted entry (${st5Exhausted.reason}). Event marked handled, no positions touched.`);
        continue;
      }
      // See the matching ST15 comment above for the full rationale —
      // waitRetest (incl. EXHAUSTED as of the 29 Aug 2026 ATR-balance
      // tuning) must be requeued, not bypassed, or P0 buys immediately
      // into the same over-extended entry the gate exists to stop.
      if (st5Exhausted.waitRetest) {
        const st5LiveCheck = checkExhaustedEntry(entry.supertrend5m, entry.supertrend15m, {
          triggerStatus: entry?.triggerStatus ?? null,
          regime: marketState?.marketRegime ?? null,
          breadthScore: marketState?.breadth?.score ?? null,
        });
        if (st5LiveCheck.waitRetest) {
          event.status = 'PENDING';
          logAudit('st5_wait_retest', { pair, id: event.id, reason: st5LiveCheck.reason });
          continue;
        }
        logAudit('st5_retest_confirmed', { pair, id: event.id, reason: st5LiveCheck.reason });
      }
      if (st5Exhausted.overrideUsed) {
        logAudit('st5_exhausted_override', { pair, id: event.id, reason: st5Exhausted.reason });
        await sendTelegram(`⚡ *ST5 CROSS — ${base}* — EXHAUSTED-zone hard block bypassed (${st5Exhausted.reason}).`);
      }
    }

    console.log(`  🟣  ST5_CROSS_UP — ${pair} [${event.id}] — Priority-0 (P0) execution starting`);
    logAudit('st5_event_consumed', { pair, id: event.id, candleTime: event.candleTime });
    await sendTelegram(
      `🟢 *HIGH PRIORITY (P0) — 5m SUPERTREND CROSS UP* — ${base}USDT — ${utc}\n` +
      `  Price: $${event.close}  5m Supertrend: $${event.supertrend}  Cross distance: +${event.distancePct}%\n` +
      `  Candle: ${event.candleTime}\n` +
      `  Event: \`${event.id}\`\n` +
      `  🔓 Normal BUY conditions bypassed — safety checks in progress…`
    );

    // ── SELL every other currently-held crypto position that's currently
    // ABOVE its own buy price (tracked AND, in live mode, any untracked
    // real MEXC balance — untracked has no buy-price record to compare
    // against, so it's swept unconditionally same as before) — never the
    // ST target itself.
    //
    // ST5 is Priority-0 for STRATEGY qualification (grade/conv/cooldown/
    // momentum/etc. — see the big comment above this function), but that
    // was never meant to force realizing a loss on an unrelated held
    // position just to fund this buy. That's the exact same "never let
    // rotation lock in a loss on a position that hasn't hit its own stop"
    // principle the normal executeRotation() applies via its Guard 2 above
    // — simpler here since ST5 doesn't need the other rotation guards
    // (min-hold, momentum, stagnation), just this one. ST5_MIN_PROFIT_PCT
    // reads the SAME ROTATION_MIN_PROFIT_PCT (default 0.2%) normal
    // rotation and ST15 use — one repo Variable controls the minimum-profit
    // threshold everywhere, no separate ST5_MIN_PROFIT_PCT Variable.
    //
    // A protected (still-underwater) position is simply left alone — if
    // that leaves no live-trade capacity for the ST buy, the concurrency-
    // cap check further down reports it and skips the buy this cycle
    // rather than forcing a sell.
    const sellAlerts = [];
    let sellFailed = false;
    const protectedPositions = [];

    const ST5_MIN_PROFIT_PCT = parseFloat(process.env.ROTATION_MIN_PROFIT_PCT || '0.2');
    // See the matching ST15 comment above for the full trade-log rationale.
    const ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT = parseFloat(process.env.ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT || '1');
    const isAboveBuyPrice = (pos, curPrice) => {
      const buyPrice = pos?.liveOrder?.fillPrice;
      if (!buyPrice || curPrice === undefined || curPrice === null || isNaN(curPrice)) return false; // no data — don't sell blind
      const minPct = ['ST5 PRIORITY', 'ST15 PRIORITY'].includes(pos?.setup) ? ST_PRIORITY_ROTATION_OUT_MIN_PROFIT_PCT : ST5_MIN_PROFIT_PCT;
      return parseFloat(curPrice) > parseFloat(buyPrice) * (1 + minPct / 100);
    };

    const trackedToSell = [];
    for (const [key, p] of Object.entries(positions)) {
      const eligible = p.assetType === 'crypto' && p.base !== base
        && p.liveOrder?.mode === effectiveTradeMode && !p.liveOrder?.closedAt
        && !['stopped', 'tp2_hit'].includes(p.status);
      if (!eligible) continue;
      if (isSellQuarantined(p)) {
        protectedPositions.push(`${p.base} (quarantined)`);
        logAudit('st5_rotation_sell_quarantined', { base: p.base, eventId: event.id, sellBlockedAt: p.sellBlockedAt });
        continue;
      }
      // Live MEXC price fetched RIGHT NOW — see the matching comment in
      // the ST15 block above / mexcGetLivePrice in mexc-client.js.
      let curPrice = null;
      if (effectiveTradeMode === 'live') {
        try { curPrice = await mexcGetLivePrice(p.base + 'USDT'); }
        catch (e) { console.log(`  ⚠️  ST5: live price fetch failed for ${p.base} (${e.message}) — falling back to market-data.json snapshot`); }
      }
      if (curPrice == null) curPrice = parseFloat((market.symbols || {})[p.base + 'USDT']?.price);
      if (!isAboveBuyPrice(p, curPrice)) {
        protectedPositions.push(p.base);
        logAudit('st5_rotation_sell_protected', { base: p.base, eventId: event.id, buyPrice: p.liveOrder?.fillPrice, curPrice });
        continue;
      }
      trackedToSell.push([key, p]);
    }

    for (const [key, pos] of trackedToSell) {
      const mData       = (market.symbols || {})[pos.base + 'USDT'];
      const marketPrice = parseFloat(mData?.d?.p || pos.entryPrice || 0);
      pos.exitPrice = marketPrice;
      const closeResult = await closeLiveOrder(pos, `ST5 priority rotation — ${event.id}`, sellAlerts, effectiveTradeMode);
      const isLiveCrypto = pos.liveOrder?.mode === 'live';

      if (isLiveCrypto && !closeResult.closed) {
        delete pos.exitPrice;

        // ── zero_balance is NOT a sell failure — it means there was
        // nothing real to sell in the first place ──
        // A tracked position whose real exchange balance already reads 0
        // (sold manually outside the bot, or a prior partial close that
        // didn't fully update tracking — same root cause
        // monitorPositions' staleZeroBalanceStrikes guards against on the
        // normal monitor cycle) must not block this buy. ST priority
        // already treats "sell everything else" as unconditional, so
        // there's no reason to wait out a multi-cycle strike counter here
        // the way the normal path does — close the stale tracking entry
        // immediately (recording it in the trade log so the Journal still
        // shows it closed, not just vanishing) and continue to the BUY.
        if (closeResult.reason === 'zero_balance') {
          console.log(`  ℹ️  ST5 rotation — ${pos.base} tracked but exchange balance is 0 (stale entry) — closing tracking, NOT blocking the ${base} BUY`);
          pos.status              = 'stopped';
          pos.statusChangedAt     = Date.now();
          pos.liveOrder.closedAt      = Date.now();
          pos.liveOrder.exitFillPrice = pos.liveOrder.fillPrice; // real exit price unknown — not a bot-tracked sell
          recordTradeClose(pos, `st5_priority_rotation_stale_zero_balance — ${event.id}`, { qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.exitFillPrice });
          await pushTradeLogToGitHub(loadTradeLog());
          logAudit('st5_stale_position_cleared', { base: pos.base, eventId: event.id });
          await sendTelegram(`🔍 *ST5 ROTATION — STALE POSITION CLOSED* — ${pos.base}: exchange balance already 0 (sold outside the bot) — closed tracking, no sell needed. Not blocking the ${base} buy.`);
          changed = true;
          continue; // does NOT set sellFailed — buy proceeds
        }

        sellFailed = true;
        pos.sellBlockedAt = Date.now();
        pos.sellBlockedReason = closeResult.reason || 'unknown';
        logAudit('st5_sell_quarantine_set', { base: pos.base, eventId: event.id, reason: pos.sellBlockedReason, quarantineMin: ST_FAILED_SELL_QUARANTINE_MIN });
        console.log(`  🛑  ST5 rotation SELL failed for ${pos.base} (${closeResult.reason}) — aborting BUY for ${base}, quarantining ${pos.base} for ${ST_FAILED_SELL_QUARANTINE_MIN}min`);
        continue;
      }
      const finalExitPrice = pos.liveOrder?.exitFillPrice || marketPrice;
      const pnlPct = pos.entryPrice > 0
        ? parseFloat(((finalExitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)) : 0;

      closedOutcomes.push({
        base: pos.base, pair: pos.base + 'USDT',
        entryTriggerStatus: pos.entryTriggerStatus ?? null, entryStateAtBuy: pos.entryStateAtBuy ?? null,
        outcome: 'st5_priority_rotation', score: pos.score, spikeScore: pos.spikeScore,
        pnlPct, closedAt: Date.now(),
      });
      pos.status          = 'stopped';
      pos.statusChangedAt = Date.now();
      pos.exitPrice       = finalExitPrice;
      pos.rotatedOut      = true;
      changed = true;
    }

    // Live mode only — sweep any REAL MEXC balance with no positions.json
    // entry at all (bought manually outside the bot), same as normal
    // rotation's untracked branch, so it can't silently block freeing
    // balance for the ST buy below.
    if (effectiveTradeMode === 'live' && !sellFailed) {
      let balances = [];
      try { balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET); }
      catch (e) { console.log(`  ⚠️  ST5: couldn't fetch MEXC balances (${e.message}) — skipping untracked sweep`); }

      for (const bal of balances) {
        const balBase = bal.asset;
        if (balBase === base || QUOTE_ASSETS.has(balBase) || isNoTradeSymbol(balBase + 'USDT')) continue;
        const alreadyTracked = Object.values(positions).some(p => p.base === balBase && p.assetType === 'crypto' && !p.liveOrder?.closedAt);
        if (alreadyTracked) continue; // handled by the tracked loop above

        const untrackedSym = balBase + 'USDT';
        const mPrice = parseFloat((market.symbols || {})[untrackedSym]?.d?.p || 0);
        try {
          const step    = await getBaseSizePrecision(untrackedSym);
          const sellQty = floorToStep(bal.free, step);
          const estNotional = bal.free * mPrice;
          if (mPrice > 0 && bal.free > 0 && estNotional < MIN_SELL_NOTIONAL_USDT) {
            logAudit('st5_sell_skipped_dust', { sym: untrackedSym, reason: 'st5_priority_untracked', freeQty: bal.free, estNotional });
            continue; // dust — leave on exchange, doesn't block the buy
          }
          if (sellQty <= 0) continue;
          const sell = await mexcMarketSell(MEXC_API_KEY, MEXC_API_SECRET, untrackedSym, sellQty);
          logAudit('st5_sell_untracked', { sym: untrackedSym, qty: sellQty, fillPrice: sell.fillPrice, orderId: sell.orderId, eventId: event.id });
          await sendTelegram(`🟢 *ST5 ROTATION SELL (untracked)* — closed ${sellQty} ${balBase} @ $${sell.fillPrice.toFixed(6)} on MEXC to fund the ${base} priority buy.`);
          changed = true;
        } catch (e) {
          if (/minimum transaction volume/i.test(e.message || '')) {
            logAudit('st5_sell_skipped_dust', { sym: untrackedSym, reason: 'st5_priority_untracked', error: e.message });
            continue;
          }
          logAudit('st5_sell_untracked_failed', { sym: untrackedSym, error: e.message, eventId: event.id });
          await sendTelegram(`🚨 *ST5 ROTATION SELL FAILED (untracked)* — ${balBase}: ${e.message} — CLOSE MANUALLY on MEXC. ${base} priority BUY continuing regardless (this balance wasn't required for it).`);
        }
      }
    }

    for (const m of sellAlerts) await sendTelegram(m);

    if (sellFailed) {
      event.status = 'SELL_FAILED';
      logAudit('st5_sell_failed', { pair, id: event.id });
      await sendTelegram(`🚨 *ST5 CROSS — SELL FAILED* — ${base}: could not confirm sale of an existing position — BUY ABORTED. Event left for manual review, will not retry automatically.`);
      continue; // never buy after an unconfirmed sell
    }

    // ── Live concurrency cap — still an account/infra-level control, same
    // class as balance/lot-size, not a strategy gate the note lists as
    // bypassed. Selling everything above should already have freed a slot;
    // this is a fallback in case a sell above was legitimately skipped
    // (e.g. dust) rather than failed. ──
    if (effectiveTradeMode === 'live' && countLiveOpenPositions(positions) >= effectiveMaxLive) {
      event.status = 'BLOCKED_MAX_LIVE';
      logAudit('st5_blocked_max_live', { pair, id: event.id, protectedPositions });
      // See the matching ST15/P1 comment above — engages the rotation
      // cooldown on a skip, not just a real execution, so this doesn't
      // re-fire and re-alert every cycle. Doesn't touch `changed`.
      markSTRotationExecuted(tradeState);
      await sendTelegram(
        `🚫 *ST5 CROSS — ${base}* — still at ${effectiveMaxLive}/${effectiveMaxLive} live trade cap after rotation sells — BUY skipped this cycle.\n` +
        (protectedPositions.length
          ? `  🛡 _${protectedPositions.join(', ')} kept — currently at/below buy price, not sold at a loss. Will retry once a slot frees up._`
          : '')
      );
      continue;
    }

    // ── BUY the ST candidate ──
    const now   = Date.now();
    const shock = entry?.d?.shock ?? 1;

    const { totalUsd: st5TotalUsd } = await computeSTPriorityUsdSize({
      effectiveTradeMode, effectiveSizeMode, effectiveSizePct,
      fallbackUsdSize: ST5_PRIORITY_USD_SIZE, label: 'ST5 priority',
    });
    const st5UsdSize = parseFloat((st5TotalUsd / basketSize).toFixed(2));
    if (st5UsdSize <= 0) {
      event.status = 'BLOCKED_ZERO_BALANCE';
      logAudit('st5_blocked_zero_balance', { pair, id: event.id });
      // See the matching ST15/P1 comment above. Doesn't touch `changed`.
      markSTRotationExecuted(tradeState);
      await sendTelegram(`🚫 *ST5 CROSS — ${base}* — $0 available after rotation sells (percent sizing) — BUY skipped this cycle.`);
      continue;
    }

    positions[sym] = {
      sym, base, assetType: 'crypto', exchangePrefix: entry.exchangePrefix || 'BINANCE', session: '24/7',
      setup: 'ST5 PRIORITY', dir: 'bull',
      alertedAt: now, holdLockUntil: now, // no hold-lock delay for a priority execution
      entryPrice: 0, stop: 0, t1: 0, t2: 0, // resynced to the real fill just below
      score: entry.conv ?? null, spikeScore: shock,
      exitAlertedAt: null, tier1AlertedAt: null,
      status: 'watching',
      source: 'st5_priority_v1',
      scoreSource: 'st5_cross',
      st5EventId: event.id,
    };

    if (effectiveTradeMode === 'paper') {
      const fillPrice = parseFloat(entry?.d?.p || event.close || 0);
      const qty        = fillPrice > 0 ? st5UsdSize / fillPrice : 0;
      positions[sym].liveOrder = { mode: 'paper', buyAt: now, usdSize: st5UsdSize, qty, fillPrice, buyOrderId: `PAPER_ST5_${now}` };
      const lvl = recalcLevelsFromFill(fillPrice, shock);
      if (lvl) { positions[sym].entryPrice = fillPrice; positions[sym].stop = lvl.stop; positions[sym].t1 = lvl.t1; positions[sym].t2 = lvl.t2; }
      positions[sym].entrySnapshot      = buildEntrySnapshot(entry || {}, {});
      positions[sym].entryTriggerStatus = entry.triggerStatus ?? null;
      positions[sym].entryStateAtBuy    = 'ST5_CROSS_UP';
      logAudit('st5_paper_buy', { sym, id: event.id, usdSize: st5UsdSize, fillPrice });
      recordTradeOpen(positions[sym], { mode: 'paper', orderId: positions[sym].liveOrder.buyOrderId, qty, fillPrice, usdSize: st5UsdSize });
      await pushTradeLogToGitHub(loadTradeLog());
      if (effectiveSizeMode === 'percent') adjustPaperBalance(-st5UsdSize);
      changed = true;
      event.status = 'EXECUTED';
      await sendTelegram(
        `📝 *ST5 PRIORITY PAPER BUY* — ${base} $${st5UsdSize} USDT @ ~$${fillPrice.toFixed(6)}\n` +
        `  Event \`${event.id}\` marked EXECUTED.\n  _Paper mode — no real order placed._` +
        (protectedPositions.length ? `\n  🛡 _${protectedPositions.join(', ')} kept — at/below buy price, not sold at a loss._` : '')
      );
    } else {
      console.log(`  🟢  ST5 PRIORITY LIVE BUY — ${pair} $${st5UsdSize} USDT via MEXC...`);
      try {
        // NOTE: MEXC's REST API wants the bare pair ("TAOUSDT"), not the
        // TradingView-style prefixed `sym` ("BINANCE:TAOUSDT") used as the
        // internal positions[] tracking key — passing `sym` here caused
        // every ST5 live buy to fail with "Invalid symbol" (HTTP 400).
        const buy = await mexcMarketBuy(MEXC_API_KEY, MEXC_API_SECRET, pair, st5UsdSize);
        positions[sym].liveOrder = {
          mode: 'live', buyAt: now, usdSize: st5UsdSize,
          qty: buy.executedQty, fillPrice: buy.fillPrice, buyOrderId: buy.orderId, qtyEstimated: buy.estimated || false,
        };
        const lvl = recalcLevelsFromFill(buy.fillPrice, shock);
        if (lvl) { positions[sym].entryPrice = buy.fillPrice; positions[sym].stop = lvl.stop; positions[sym].t1 = lvl.t1; positions[sym].t2 = lvl.t2; }
        positions[sym].entrySnapshot      = buildEntrySnapshot(entry || {}, {});
        positions[sym].entryTriggerStatus = entry.triggerStatus ?? null;
        positions[sym].entryStateAtBuy    = 'ST5_CROSS_UP';
        logAudit('st5_live_buy', { sym, id: event.id, usdSize: st5UsdSize, qty: buy.executedQty, fillPrice: buy.fillPrice, orderId: buy.orderId });
        recordTradeOpen(positions[sym], { mode: 'live', orderId: buy.orderId, qty: buy.executedQty, fillPrice: buy.fillPrice, usdSize: st5UsdSize });
        await pushTradeLogToGitHub(loadTradeLog());
        changed = true;
        event.status = 'EXECUTED';
        await sendTelegram(
          `🟢 *ST5 PRIORITY LIVE BUY* — ${base} — ${utc}\n` +
          `  MEXC MARKET BUY: ${buy.executedQty}${buy.estimated ? ' (estimated)' : ''} @ $${buy.fillPrice.toFixed(6)}\n` +
          `  Size: $${st5UsdSize} USDT  Order ID: \`${buy.orderId}\`\n` +
          `  Event \`${event.id}\` marked EXECUTED.\n` +
          `  🛡 Watched by the normal stop/T1/T2 monitor from here on.\n` +
          (protectedPositions.length ? `  🛡 _${protectedPositions.join(', ')} kept — at/below buy price, not sold at a loss._\n` : '') +
          `  _Send /pause to halt further auto-buys_`
        );
      } catch (e) {
        delete positions[sym]; // no phantom tracking entry — mirrors executeAutoBuys' live-buy-failed cleanup
        event.status = 'BUY_FAILED';
        logAudit('st5_live_buy_failed', { sym, id: event.id, error: e.message });
        await sendTelegram(
          `🚨 *ST5 PRIORITY BUY FAILED* — ${base}: ${e.message}\n` +
          `  Rotation SELL already completed — you may be holding extra USDT with no new position.\n` +
          `  Event marked BUY_FAILED, will not retry automatically. Check MEXC manually.`
        );
      }
    }
  }

  if (changed) markSTRotationExecuted(tradeState);
  return { changed };
}

// ── Adopts manually-bought MEXC holdings into bot tracking ──
// A coin bought directly on MEXC (outside the bot) has no positions.json
// entry, no bot-placed stop, and is invisible to monitorPositions' T1/T2/
// stop/exit checks — those only ever look at positions.json. Left
// untracked, it would only ever get sold as a side effect of ROTATION
// (see executeRotation's "untracked" branch above), and only once a
// DIFFERENT symbol becomes the new pick — never on its own T1/T2/exit
// signal, and never protected by a stop.
//
// Called every live-mode cycle, before the buy-signal scan: any live MEXC
// balance with no matching non-terminal positions.json entry gets a
// tracking record created for it, plus an immediate real exchange-side
// stop. From the next monitorPositions pass onward it's managed exactly
// like a bot-opened position: T1/T2/stop/exit-signal all apply normally.
// It also can never get double-bought, since the open-position gate in the
// scan loop sees it as already-tracked the moment this function runs.
//
// Entry price = the REAL fill price recovered from MEXC's own trade
// history (GET /api/v3/myTrades) for the balance being adopted, so P&L is
// measured against the actual cost basis rather than whatever the market
// happens to be trading at the moment this cycle first notices the coin.
// Only falls back to current market price if trade history can't be
// fetched or no matching BUY fills are found — the Telegram alert and
// liveOrder.priceSource always say which one was used, so a fallback
// adoption is never silently mistaken for a real cost basis.
export async function adoptManualHoldings({ positions, market, evaluateSymbol, calcEntryLevels }) {
  let changed = false;
  let balances = [];
  try {
    balances = await mexcGetAllBalances(MEXC_API_KEY, MEXC_API_SECRET);
  } catch (e) {
    console.log(`  ⚠️  Manual-holding adoption: couldn't fetch MEXC balances (${e.message})`);
    return { positions, changed };
  }

  for (const bal of balances) {
    const base = bal.asset;
    if (QUOTE_ASSETS.has(base) || isNoTradeSymbol(base + 'USDT')) continue;
    if (bal.free <= 0) continue; // nothing sellable — fully locked elsewhere, skip
    const bareSym = base + 'USDT';
    const sym = buildSymKey(bareSym); // normalized key (e.g. 'BINANCE:LINKUSDT') —
    // matches the format used by the buy-scan/leaderboard pipeline, so a
    // manually-adopted holding and a later signal for the same symbol land
    // under the SAME positions[] key instead of creating a duplicate
    // tracked entry. market.symbols itself is keyed by the BARE pair
    // (confirmed against market-data.json), so that lookup below
    // deliberately still uses bareSym, not sym.

    const alreadyTracked = Object.values(positions).some(p =>
      p.base === base && p.assetType === 'crypto' && !p.liveOrder?.closedAt
      && (
        // Non-terminal tracking (normal case): still watching/tp1/exiting.
        (!['stopped', 'tp2_hit'].includes(p.status) && !(p.status === 'tp1_hit' && p.exitPrice))
        // Terminal-but-unsold: status says 'stopped'/'tp2_hit' but the
        // liveOrder was never actually closed (no closedAt) — e.g.
        // alert-runner.js's watchlist-style stop check stamped the status
        // without ever calling closeLiveOrder(). Treating this as "already
        // tracked" prevents re-adopting the same still-real MEXC balance as
        // a brand-new position every cycle (which reset alertedAt/stop and
        // caused an infinite fake-stop/re-adopt loop, spamming STOP HIT
        // alerts every ~5min while the real coin sat unsold). Leaving it
        // tracked here means monitorPositions()/closeLiveOrder() gets the
        // next real chance to actually sell it instead.
        || (['stopped', 'tp2_hit'].includes(p.status) && p.liveOrder?.mode === 'live' && !p.liveOrder?.closedAt)
      )
    );
    if (alreadyTracked) continue; // bot-bought, already adopted, or stopped-but-unsold — leave it

    const entry = (market.symbols || {})[bareSym];
    if (!entry || entry.assetType !== 'crypto') {
      console.log(`  ⚠️  ${base} held on MEXC but not in market-data.json — can't compute stop/T1/T2, skipping adoption this cycle`);
      continue;
    }

    // Dust guard — checked BEFORE adoption, not after. Without this, a
    // balance too small to ever sell (e.g. a leftover fraction from a
    // previous partial sell) gets adopted and alerted about, then
    // immediately closed out as dust by the sell-side guard on its very
    // next monitoring pass, then re-adopted again next cycle since
    // adoption has no memory of having already dismissed it — an endless
    // loop of "MANUAL POSITION ADOPTED" noise for a balance that will
    // never be worth anything. Same threshold used by every other dust
    // check in this codebase (MEXC_MIN_SELL_NOTIONAL_USDT, default $1).
    const estNotionalPreAdopt = bal.free * (entry.price || 0);
    if (entry.price > 0 && estNotionalPreAdopt < MIN_SELL_NOTIONAL_USDT) {
      logAudit('adoption_skipped_dust', { sym, base, free: bal.free, estNotional: estNotionalPreAdopt });
      continue; // silent, no Telegram alert — this is expected/routine, not worth a message every cycle
    }

    // Recover the REAL fill price of the manual buy from MEXC's own trade
    // history instead of defaulting straight to whatever the market is
    // trading at when this cycle happens to run — those two can differ
    // enough to flip a real loss into a reported profit (e.g. bought at
    // .1088, this cycle first sees it when price has drifted to .1066:
    // adopting at .1066 makes a later .1084 exit look like a +1.7% win when
    // it was actually a real loss against the .1088 cost basis).
    // Walks trade history backward (most recent first) accumulating BUY
    // fills until their quantity covers the current free balance — a FIFO
    // approximation (skips SELL rows on the assumption they consumed older
    // lots first) rather than an exact reconciliation, but far closer to
    // the truth than "current price" for the common case of one manual buy.
    let realFillPrice = null;
    let priceSource = 'current_market_fallback';
    try {
      const trades = await mexcGetMyTrades(MEXC_API_KEY, MEXC_API_SECRET, bareSym, 50);
      let remaining = bal.free, costSum = 0, qtySum = 0;
      for (let i = trades.length - 1; i >= 0 && remaining > 1e-12; i--) {
        const t = trades[i];
        if (!t.isBuyer) continue;
        const take = Math.min(t.qty, remaining);
        costSum += take * t.price;
        qtySum  += take;
        remaining -= take;
      }
      if (qtySum > 0) {
        realFillPrice = costSum / qtySum;
        priceSource = remaining > 1e-9 ? 'trade_history_partial' : 'trade_history';
      }
    } catch (e) {
      console.log(`  ⚠️  ${base}: couldn't fetch MEXC trade history (${e.message}) — falling back to current price for adoption`);
    }

    const adoptionPrice = realFillPrice ?? entry.price;
    const evald  = evaluateSymbol(entry);
    const levels = calcEntryLevels(adoptionPrice, evald.shock);

    const usdSizeEst = parseFloat((bal.free * adoptionPrice).toFixed(2));
    positions[sym] = {
      sym, base, assetType: 'crypto',
      exchangePrefix: entry.exchangePrefix, session: entry.session,
      // dir is ALWAYS 'bull' here — this is a MEXC SPOT adoption of a REAL
      // owned balance, which can only ever be a long position (spot has no
      // short-selling). evald.setup.label ('SHORT SETUP' etc.) describes
      // the CURRENT signal direction, not what's actually held — using it
      // to set dir was wrong: position-monitor.js's stop/T1/T2 hit checks
      // are all gated on `pos.dir !== 'bear'` and there is NO bear-side
      // equivalent anywhere in the codebase (this bot never shorts), so a
      // position tagged dir:'bear' silently loses ALL price-based stop-loss
      // and take-profit protection forever — it can only ever exit via
      // rotation, manual-sell detection, or staleness eviction. This is
      // exactly what happened to XMR: it got re-adopted here (its original
      // bot-buy tracking was lost, most likely to a positions.json push
      // race — see the dedup-guard note below) while its live signal had
      // turned bearish, tagging it dir:'bear' and disabling its stop.
      setup: evald.setup.label, dir: 'bull',
      alertedAt: Date.now(), holdLockUntil: 0,
      entryPrice: parseFloat(levels.entry), stop: parseFloat(levels.stop),
      t1: parseFloat(levels.t1), t2: parseFloat(levels.t2),
      score: evald.conv, spikeScore: evald.shock,
      exitAlertedAt: null, tier1AlertedAt: null,
      status: 'watching', source: 'manual_adopted', scoreSource: evald.source,
      recommended: false,
      liveOrder: {
        mode: 'live', buyAt: Date.now(), usdSize: usdSizeEst,
        qty: bal.free, fillPrice: adoptionPrice, buyOrderId: `MANUAL_ADOPTED_${Date.now()}`,
        adopted: true, priceSource,
      },
    };
    logAudit('manual_position_adopted', { sym, base, qty: bal.free, entryPrice: adoptionPrice, priceSource, currentMarketPrice: entry.price, stop: levels.stop });
    changed = true;

    // ── Dedupe guard — see hasOpenTradeLogEntry() in job-state.js ──
    // positions.json (this cycle's local checkout) says this coin isn't
    // tracked, which is what triggered adoption above — but the PERMANENT
    // trade log may disagree if a previous cycle's positions.json push lost
    // a race and got silently dropped (see putGitHubContent's retry, and
    // the note on decide's ~5min cadence overlapping with the Cloudflare
    // Worker trigger). If the trade log already shows this exact sym+mode
    // as 'open', this is that same still-open holding being re-seen, not a
    // new buy — refresh the tracking record (already done above, keeps
    // stop/T1/T2 current) but don't log a second row or re-alert.
    if (hasOpenTradeLogEntry(sym, 'live')) {
      console.log(`  ♻️  ${base} — already has an OPEN trade-log entry for ${sym}; positions.json was stale (likely a lost push race) — re-tracking without duplicating the log row or alert`);
      logAudit('manual_adoption_dedup_skipped', { sym, base, qty: bal.free });
      continue;
    }

    recordTradeOpen(positions[sym], {
      mode: 'live', orderId: positions[sym].liveOrder.buyOrderId,
      qty: bal.free, fillPrice: adoptionPrice, usdSize: usdSizeEst,
    });
    await pushTradeLogToGitHub(loadTradeLog());

    const priceNote = priceSource === 'trade_history'
      ? `  _P&L tracked from your actual MEXC buy fill(s) — real cost basis._`
      : priceSource === 'trade_history_partial'
        ? `  _P&L tracked from a partial match against your MEXC trade history — some of this balance's origin trades weren't found, so treat as an estimate._`
        : `  _P&L tracked from THIS adoption price, not your real buy price — trade history lookup failed, so the bot has no way to know your actual cost basis. Verify manually._`;

    await sendTelegram(
      `🔍 *MANUAL POSITION ADOPTED* — ${base}\n` +
      `  Found ${bal.free} ${base} on MEXC with no bot tracking — now under bot management.\n` +
      `  Adoption price $${adoptionPrice}  Stop $${levels.stop}  T1 $${levels.t1}  T2 $${levels.t2}\n` +
      `  🛡 Watched by the 15-min software stop check.\n` +
      priceNote
    );
  }

  return { positions, changed };
}

// ── Star-pick auto-buy ──
//
// Two execution strategies (GUI toggle → trade-state.json, OR repo Variables
// EXEC_STRATEGY / EXEC_TOP_N_COUNT as the durable default the GUI overrides):
//   'top1'  — buy only the ⭐ #1 ranked symbol, full order size
//   'topN'  — buy the top EXEC_TOP_N_COUNT starred symbols (e.g. 2 or 3;
//             unset/0 = every currently-starred symbol, uncapped),
//             order size split equally
//             e.g. $75 / 3 picks = $25 each — this split is a fixed rule,
//             not a separate config value (top1 is always 100% of size)
//
// Order size itself has two modes (TRADE_SIZE_MODE / GUI toggle):
//   'usd'     — fixed-dollar TRADE_USD_SIZE, unchanged from before
//   'percent' — TRADE_SIZE_PCT% of available balance, fetched fresh each
//               cycle (live: real MEXC USDT balance; paper: tracked virtual
//               balance in paper-balance.json). 100% + topN splits the WHOLE
//               balance across picks. A profitable close feeds straight back
//               into the balance, so the NEXT buy compounds automatically.
//
// Gates (per-symbol, all must pass):
//   1. TRADE_MODE is 'paper' or 'live' (not 'off')
//   2. tradingEnabled flag (Telegram /pause kill-switch)
//   3. Symbol is in the ⭐ recommended set (showRecoTags fired)
//   4. Not already holding too many live open trades (TRADE_MAX_CONCURRENT_LIVE)
//   5. Idempotency: positions[sym].liveOrder not already set
// ── NOTE: exchange-side stop-loss removed ──
// MEXC's /api/v3/order endpoint only accepts type LIMIT or MARKET — there is
// no stopPrice param and no OCO/stop endpoint in MEXC's documented spot v3
// API (confirmed against MEXC's own API docs). The previous STOP_LOSS_LIMIT
// attempt here was Binance-endpoint naming that MEXC has never supported, so
// it failed on every single live buy (HTTP 400 "invalid type"). Removed —
// the 15-min software stop check in position-monitor.js is the only stop
// mechanism MEXC's API allows, and is now PRIMARY, not a fallback.

// ── Rank-weighted capital allocation across this cycle's picks ──
// Default behavior (unchanged): split totalUsd evenly across picks.
// EXEC_ALLOC_WEIGHTED=true switches to a 70/30 rule — the #1 pick gets
// 70% and the remaining slots split the other 30% equally — but ONLY
// when picks[0] is a genuinely clear leader over picks[1]: either a
// strictly higher letter grade, or (same grade) a rankScore lead of at
// least EXEC_ALLOC_LEAD_SCORE_GAP_PCT (default 10%, relative to the
// leader's own rankScore). Anything short of that falls back to equal
// split — comparable candidates should be sized comparably.
// picks are always sorted best-first (allStarred/ranked preserves rank
// order), so picks[0]/picks[1] is always "leader vs runner-up".
function computeAllocationWeights(picks, totalUsd) {
  const n = picks.length;
  if (n <= 1) return [totalUsd];

  const equalSplit = () => {
    const each = Math.floor((totalUsd / n) * 100) / 100; // floor — slices must never sum above totalUsd
    return picks.map(() => each);
  };

  const WEIGHTED = (process.env.EXEC_ALLOC_WEIGHTED || 'false').toLowerCase() === 'true';
  if (!WEIGHTED) return equalSplit();

  const LEAD_SCORE_GAP_PCT = parseFloat(process.env.EXEC_ALLOC_LEAD_SCORE_GAP_PCT || '0.1');
  const top = picks[0], next = picks[1];
  const topGradeRank  = GRADE_RANK[top.a.entry?.grade]  ?? 0;
  const nextGradeRank = GRADE_RANK[next.a.entry?.grade] ?? 0;
  const scoreGap = top.rankScore > 0 ? (top.rankScore - next.rankScore) / top.rankScore : 0;
  const clearLeader = topGradeRank > nextGradeRank || scoreGap >= LEAD_SCORE_GAP_PCT;

  if (!clearLeader) return equalSplit();

  const leaderUsd  = Math.floor(totalUsd * 0.70 * 100) / 100;
  const remainder  = totalUsd - leaderUsd;
  const restEach   = Math.floor((remainder / (n - 1)) * 100) / 100;
  return [leaderUsd, ...Array(n - 1).fill(restEach)];
}

async function executeAutoBuys({
  ranked, showRecoTags, positions, tradeState,
  effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount, effectiveUsdSize, effectiveMaxLive,
  effectiveSizeMode, effectiveSizePct, effectiveGuardSizeMult = 1,
  utc, marketState = {},
}) {
  if (effectiveTradeMode === 'off' || !showRecoTags) return;

  // MEXC is crypto-only — stocks/ETFs can be starred/recommended for the
  // Telegram alert and GUI, but must never be routed to a MEXC order. Without
  // this filter, a starred stock pick (e.g. TSX:ETHY.TO) would fall through
  // to the symbol-building logic below and produce a garbage MEXC pair.
  const allStarred = ranked.filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair) && meetsGradeGate(r.a.entry.grade)
  );

  // Recommended picks that exist but got filtered out purely on grade —
  // surfaced once here so "nothing bought" has an obvious explanation
  // instead of looking like a silent failure.
  const gradeSkipped = ranked.filter(r =>
    r.recommended && r.a.entry.assetType === 'crypto' && !isNoTradeSymbol(r.a.pair) && !meetsGradeGate(r.a.entry.grade)
  );
  if (gradeSkipped.length && !allStarred.length) {
    const list = gradeSkipped.map(r => `${r.a.pair.replace('USDT','')} (${r.a.entry.grade || '—'})`).join(', ');
    console.log(`  🚫  No buy — recommended pick(s) below EXEC_MIN_GRADE=${EXEC_MIN_GRADE}: ${list}`);
    logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: [`grade below EXEC_MIN_GRADE (${EXEC_MIN_GRADE})`], symbols: gradeSkipped.map(r => r.a.pair) });
    await sendTelegram(`🚫 *NO BUY* — ${list} ranked #1 but grade is below EXEC_MIN_GRADE (${EXEC_MIN_GRADE}) — skipped, no positions touched.`);
  }
  // ── Stage 2 selection layer — available slots BEFORE candidate sizing ──
  // Previously `picks` was sliced straight to effectiveTopNCount (a config
  // number) with no regard for how many live slots were actually free.
  // That meant capital got divided by the CONFIGURED pick count even when
  // fewer slots were available — e.g. EXEC_TOP_N_COUNT=3 with only 1 slot
  // open still computed basePerPickUsd = totalUsd / 3, so the one pick that
  // actually clears the per-symbol liveLock check later in the loop only
  // ever received a third of the intended size, silently leaving the rest
  // of totalUsd unallocated. Computing availableSlots first — and building
  // the eligible pool from allStarred with already-held symbols excluded
  // (they don't consume a NEW slot and shouldn't shrink the split for the
  // picks that do) — means `picks.length` always equals the number of
  // symbols that can actually be bought this cycle, so capital sizing
  // below is correct by construction. The per-pick liveLock re-check later
  // in the loop stays in place as a defense-in-depth re-verify (position
  // state can still shift between this calculation and order execution).
  const currentLiveOpen  = countLiveOpenPositions(positions);
  const availableSlots   = Math.max(0, effectiveMaxLive - currentLiveOpen);
  const eligiblePool     = allStarred.filter(r => !positions[r.a.sym]?.liveOrder);
  const requestedCount   = effectiveExecStrategy === 'topN'
    ? (effectiveTopNCount || eligiblePool.length)
    : 1;
  const picks = eligiblePool.slice(0, Math.min(requestedCount, availableSlots));

  if (!picks.length) {
    if (eligiblePool.length && availableSlots <= 0) {
      console.log(`  🚫  No available live slots (${currentLiveOpen}/${effectiveMaxLive}) — no new buys this cycle.`);
      logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: [`no available live slots (${currentLiveOpen}/${effectiveMaxLive})`] });
    }
    return;
  }

  // ── Total USD allocated this cycle ──
  // 'usd'     → effectiveUsdSize is already a fixed dollar figure (unchanged
  //             behavior).
  // 'percent' → effectiveSizePct% of available balance, fetched fresh each
  //             cycle. 100% + topN naturally splits the WHOLE balance across
  //             picks below, same as the dollar case. Live mode reads the
  //             real MEXC USDT balance (so a profitable close compounds
  //             straight into the next buy's size); paper mode reads the
  //             tracked virtual paper balance (credited/debited by
  //             position-monitor.js) for the same compounding behavior.
  let totalUsd = effectiveUsdSize;
  if (effectiveSizeMode === 'percent') {
    const balance = effectiveTradeMode === 'live'
      ? await mexcFreeBalance(MEXC_API_KEY, MEXC_API_SECRET, 'USDT')
      : loadPaperBalance();
    // Reserve a small buffer even at TRADE_SIZE_PCT=100 — with zero margin,
    // independent .toFixed(2) rounding on totalUsd and each perPickUsd slice
    // can sum to a cent or two MORE than the real balance, and MEXC's own
    // internal balance check for a quoteOrderQty buy can be marginally
    // stricter than the "free" figure this just queried. Without a buffer,
    // that reliably surfaces as "Insufficient position" (MEXC code 30004 —
    // actually insufficient funds, not a real "position" issue) on the
    // SECOND (or later) buy in a multi-pick cycle, since the first buy
    // already consumed real balance before this rounding gap gets exposed.
    const SIZING_BUFFER_PCT = parseFloat(process.env.MEXC_SIZING_BUFFER_PCT || '1');
    const bufferedPct = Math.max(0, effectiveSizePct - SIZING_BUFFER_PCT);
    totalUsd = parseFloat((balance * (bufferedPct / 100) * effectiveGuardSizeMult).toFixed(2));
    console.log(`  💰  Sizing: ${bufferedPct}% of ${effectiveTradeMode} balance $${balance.toFixed(2)} (${effectiveSizePct}% target − ${SIZING_BUFFER_PCT}% buffer)${effectiveGuardSizeMult < 1 ? ` ×${effectiveGuardSizeMult} (market guard)` : ''} = $${totalUsd}`);
    if (totalUsd <= 0) {
      console.log(`  🚫  Skipping buys — $0 available (balance $${balance.toFixed(2)})`);
      logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: [`zero balance (${effectiveTradeMode})`] });
      return;
    }
  }

  // ── Per-pick allocation ── see computeAllocationWeights() — equal split
  // by default, or a 70/30 leader-weighted split when EXEC_ALLOC_WEIGHTED=true
  // and picks[0] is a clear leader over picks[1].
  const pickWeights = computeAllocationWeights(picks, totalUsd);
  const isWeightedSplit = new Set(pickWeights).size > 1;

  // ── Scout entries (leaderboard-decider.js: entry.scoutBuy) get sized
  // down to BUY_SCOUT_SIZE_PCT of the normal slice ──
  // These cleared the trigger gate at TRIGGERING rather than confirmed
  // BREAKOUT — earlier/less confirmed than a normal buy, so the position
  // size reflects that instead of committing full size to an unconfirmed
  // setup. No automatic top-up to full size if it later confirms BREAKOUT
  // (deliberately — that's a separate decision once scout-entry win-rate
  // data exists in symbol-history.json to justify it).
  const BUY_SCOUT_SIZE_PCT = parseFloat(process.env.BUY_SCOUT_SIZE_PCT || '30');

  // ── Momentum-continuation entries (leaderboard-decider.js: entry via
  // buy-intelligence.js's calcSpikeTrigger momentum-continuation path) also
  // get sized down — same reasoning as scout entries: a rising-5m-candle
  // streak is a real signal but a looser bar than an actual confirmed level
  // reclaim, so it doesn't get full size. Independent of BUY_SCOUT_SIZE_PCT
  // (a pick can be a scout entry OR a momentum entry, never both — see
  // calcSpikeTrigger, momentum only fires once the level-based paths have
  // already been ruled out for that cycle).
  const BUY_MOMENTUM_SIZE_PCT = parseFloat(process.env.BUY_MOMENTUM_SIZE_PCT || '50');

  console.log(`  ⚡  Exec strategy: ${effectiveExecStrategy} (${effectiveSizeMode === 'percent' ? effectiveSizePct + '%' : '$' + effectiveUsdSize}) — ${picks.length} pick(s), $${totalUsd} total → [${pickWeights.map(w => '$' + w).join(', ')}] (${availableSlots} slot(s) available, ${currentLiveOpen}/${effectiveMaxLive} live)`);

  if (!tradeState.tradingEnabled) {
    console.log(`  🚫  Auto-trade blocked — trading paused via Telegram /pause`);
    logAudit('mexc_blocked', { strategy: effectiveExecStrategy, reasons: ['paused'] });
    return;
  }

  for (let pickIdx = 0; pickIdx < picks.length; pickIdx++) {
    const { a: pick } = picks[pickIdx];
    const basePerPickUsd = pickWeights[pickIdx];
    const pos    = positions[pick.sym];
    const symbol = pick.pair.replace(/[^A-Z]/g, '') + (pick.pair.includes('USDT') ? '' : 'USDT');
    const isScout   = pick.entry?.scoutBuy === true;
    const isMomentum = !isScout && pick.entry?.momentumContinuation === true;
    const perPickUsd = isScout
      ? parseFloat((basePerPickUsd * (BUY_SCOUT_SIZE_PCT / 100)).toFixed(2))
      : isMomentum
        ? parseFloat((basePerPickUsd * (BUY_MOMENTUM_SIZE_PCT / 100)).toFixed(2))
        : basePerPickUsd;

    // Re-count AFTER each buy — topN must not exceed effectiveMaxLive
    // even if rotation just freed some slots at the start of this cycle.
    const liveLock = countLiveOpenPositions(positions);

    const blockedReasons = [
      pick.entry?.assetType !== 'crypto' ? `assetType:${pick.entry?.assetType} — MEXC is crypto-only` : null,
      isNoTradeSymbol(pick.pair)         ? `${pick.pair} in MEXC_NO_TRADE_SYMBOLS — alert-only, no auto-buy` : null,
      pos?.liveOrder                    ? 'liveOrder already set (idempotency guard)' : null,
      liveLock >= effectiveMaxLive      ? `already ${liveLock}/${effectiveMaxLive} live trades open` : null,
    ].filter(Boolean);

    if (blockedReasons.length) {
      console.log(`  🚫  ${symbol} skipped — ${blockedReasons.join(', ')}`);
      logAudit('mexc_blocked', { sym: symbol, reasons: blockedReasons });

      // Alert specifically for max-live — this is the one case where a
      // starred, grade-passing pick gets silently dropped for a reason
      // that isn't obvious from the buy alert itself (unlike "already
      // holding this symbol", which is expected/routine every cycle).
      if (liveLock >= effectiveMaxLive) {
        await sendTelegram(
          `🚫 *NO BUY* — ${pick.pair.replace('USDT','')} ranked but already ${liveLock}/${effectiveMaxLive} live trades open — skipped, no positions touched.\n` +
          `  _Raise TRADE_MAX_CONCURRENT_LIVE if you want more concurrent positions._`
        );
      }

      // Crypto-only cleanup — leaderboard-decider.js already created this
      // positions[pick.sym] "watching" tracking entry (entryPrice/stop/
      // t1/t2 set) BEFORE mexc-trader ran, on the assumption the buy alert
      // would be followed by a real MEXC buy this same cycle. When
      // mexc-trader itself is the reason no buy happened — the symbol is on
      // MEXC_NO_TRADE_SYMBOLS, or TRADE_MAX_CONCURRENT_LIVE was already hit
      // — that tracking entry must not be left behind. `pos?.liveOrder`
      // being set is deliberately excluded here: that's the idempotency-
      // guard reason, meaning this is a REAL previously-bought holding, not
      // an unfilled watching entry — must never delete that. Exit-
      // monitoring doesn't distinguish "actually holding this" from "was
      // tracked, never bought", and would otherwise go on to watch price
      // against a phantom entryPrice/stop and eventually fire a real
      // stop-loss/T1 alert for a coin never actually bought. Mirrors the
      // identical cleanup already done in the live-buy-failure catch block
      // below, for the same underlying reason.
      if (pick.entry?.assetType === 'crypto' && !pos?.liveOrder
          && (isNoTradeSymbol(pick.pair) || liveLock >= effectiveMaxLive)) {
        delete positions[pick.sym];
      }
      continue;
    }

    if (effectiveTradeMode === 'paper') {
      console.log(`  📝  PAPER BUY${isScout ? ' (SCOUT)' : isMomentum ? ' (MOMENTUM)' : ''} — ${symbol} $${perPickUsd} USDT`);
      pos.liveOrder = {
        mode: 'paper', buyAt: Date.now(), usdSize: perPickUsd,
        qty: perPickUsd / (pick.levels ? parseFloat(pick.levels.entry) : pick.price),
        fillPrice: pick.levels ? parseFloat(pick.levels.entry) : pick.price,
        buyOrderId: `PAPER_${Date.now()}`,
      };
      // Resync entryPrice/stop/t1/t2 to the simulated fill price — a no-op
      // in practice now that calcEntryLevels() no longer chases (paper
      // fillPrice === the same pre-fill estimate), but keeps paper and live
      // on one code path instead of the two silently drifting apart again
      // if either formula changes later.
      const paperLevels = recalcLevelsFromFill(pos.liveOrder.fillPrice, pick.evald?.shock ?? 1);
      if (paperLevels) {
        pos.entryPrice = pos.liveOrder.fillPrice;
        pos.stop = paperLevels.stop; pos.t1 = paperLevels.t1; pos.t2 = paperLevels.t2;
      }
      // v15 design doc — capture the entry snapshot Position Intelligence
      // compares against every cycle for this position's whole lifetime.
      pos.entrySnapshot = buildEntrySnapshot(pick.entry || {}, marketState);
      // Freeze the trigger/entry-timing state AT THE MOMENT OF BUY — these
      // fields on `entry`/`d` get recomputed fresh every cycle, so without
      // capturing them here they'd just reflect "whatever the last cycle
      // before close happened to look like" by the time a position closes,
      // not what actually justified the entry. Carried through to
      // symbol-history.json on close (see closedOutcomes.push sites) so
      // win-rate can be measured by entry timing (BREAKOUT vs TRIGGERING
      // vs RETEST+TRIGGERING) instead of guessing whether buying earlier
      // (before full breakout confirmation) is actually worth the risk.
      pos.entryTriggerStatus = pick.entry?.triggerStatus ?? null;
      pos.entryStateAtBuy    = pick.entry?.entryState ?? null;
      logAudit('mexc_paper_buy', { sym: symbol, usdSize: perPickUsd, fillPrice: pos.liveOrder.fillPrice });
      recordTradeOpen(pos, {
        mode: 'paper', orderId: pos.liveOrder.buyOrderId,
        qty: pos.liveOrder.qty, fillPrice: pos.liveOrder.fillPrice, usdSize: perPickUsd,
      });
      await pushTradeLogToGitHub(loadTradeLog());
      if (effectiveSizeMode === 'percent') adjustPaperBalance(-perPickUsd);
      await sendTelegram(
        `📝 *PAPER BUY${isScout ? ' — SCOUT' : isMomentum ? ' — MOMENTUM' : ''}* — ${pick.pair.replace('USDT','')} $${perPickUsd} USDT @ ~$${pos.liveOrder.fillPrice.toFixed(6)}\n` +
        `  Strategy: ${effectiveExecStrategy === 'topN' ? `top${picks.length}${isWeightedSplit ? ' weighted split' : ' split'}` : 'top 1'}\n` +
        (isScout ? `  🔎 _Scout entry — TRIGGERING, not yet confirmed BREAKOUT. Sized at ${BUY_SCOUT_SIZE_PCT}% of normal — no automatic top-up if it confirms._\n` : '') +
        (isMomentum ? `  📈 _Momentum entry — ${pick.entry?.risingStreak ?? '?'} consecutive rising 5m closes, no level reclaim yet. Sized at ${BUY_MOMENTUM_SIZE_PCT}% of normal._\n` : '') +
        `  _Paper mode — no real order placed. Set TRADE\\_MODE=live to trade for real._`
      );
    } else {
      // Live mode — real MEXC market buy
      console.log(`  ⚡  LIVE BUY${isScout ? ' (SCOUT)' : isMomentum ? ' (MOMENTUM)' : ''} — ${symbol} $${perPickUsd} USDT via MEXC...`);
      try {
        const buy = await mexcMarketBuy(MEXC_API_KEY, MEXC_API_SECRET, symbol, perPickUsd);
        pos.liveOrder = {
          mode: 'live', buyAt: Date.now(), usdSize: perPickUsd,
          qty: buy.executedQty, fillPrice: buy.fillPrice, buyOrderId: buy.orderId,
          qtyEstimated: buy.estimated || false,
        };
        // Resync entryPrice/stop/t1/t2 to what MEXC actually filled at —
        // buy.fillPrice is derived from real executedQty/cummulativeQuoteQty
        // (see mexc-client.js deriveFillPrice()), not the pre-fill estimate
        // positions[sym] was created with in leaderboard-decider.js before
        // this order was even placed. Without this, stop distance and
        // reported P&L on every live trade were anchored to a price that
        // was never actually paid.
        const liveLevels = recalcLevelsFromFill(buy.fillPrice, pick.evald?.shock ?? 1);
        if (liveLevels) {
          pos.entryPrice = buy.fillPrice;
          pos.stop = liveLevels.stop; pos.t1 = liveLevels.t1; pos.t2 = liveLevels.t2;
        }
        // v15 design doc — capture the entry snapshot Position Intelligence
        // compares against every cycle for this position's whole lifetime.
        pos.entrySnapshot = buildEntrySnapshot(pick.entry || {}, marketState);
        // See the paper-buy branch above for why this is frozen here
        // rather than read fresh at close time.
        pos.entryTriggerStatus = pick.entry?.triggerStatus ?? null;
        pos.entryStateAtBuy    = pick.entry?.entryState ?? null;
        logAudit('mexc_live_buy', { sym: symbol, usdSize: perPickUsd, qty: buy.executedQty, fillPrice: buy.fillPrice, orderId: buy.orderId, estimated: buy.estimated, entryPrice: pos.entryPrice, stop: pos.stop });
        recordTradeOpen(pos, {
          mode: 'live', orderId: buy.orderId,
          qty: buy.executedQty, fillPrice: buy.fillPrice, usdSize: perPickUsd,
        });
        await pushTradeLogToGitHub(loadTradeLog());

        await pushTradeLogToGitHub(loadTradeLog());

        await sendTelegram(
          `⚡ *LIVE BUY PLACED${isScout ? ' — SCOUT' : isMomentum ? ' — MOMENTUM' : ''}* — ${pick.pair.replace('USDT','')} — ${utc}\n` +
          `  MEXC MARKET BUY: ${buy.executedQty}${buy.estimated ? ' (estimated — MEXC did not report a fill qty)' : ''} @ $${buy.fillPrice.toFixed(6)}\n` +
          `  Size: $${perPickUsd} USDT  Order ID: \`${buy.orderId}\`\n` +
          (effectiveExecStrategy === 'topN' ? `  Strategy: top${picks.length}${isWeightedSplit ? ' weighted split' : ' split'} ($${totalUsd} → [${pickWeights.map(w => '$' + w).join(', ')}])\n` : '') +
          (isScout ? `  🔎 _Scout entry — TRIGGERING, not yet confirmed BREAKOUT. Sized at ${BUY_SCOUT_SIZE_PCT}% of normal — no automatic top-up if it confirms._\n` : '') +
          (isMomentum ? `  📈 _Momentum entry — ${pick.entry?.risingStreak ?? '?'} consecutive rising 5m closes, no level reclaim yet. Sized at ${BUY_MOMENTUM_SIZE_PCT}% of normal._\n` : '') +
          `  🛡 Watched by the 15-min software stop check.\n` +
          `  Stop/T2 exits will close this position automatically.\n` +
          (buy.estimated ? `  ⚠️ _MEXC didn't confirm a fill quantity yet — verify the actual holding on MEXC matches before trusting auto-sells._\n` : '') +
          `  _Send /pause to halt further auto-buys_`
        );
      } catch (e) {
        logAudit('mexc_live_buy_failed', { sym: symbol, error: e.message });

        // The leaderboard-decider step earlier this cycle already created
        // a `positions[pick.sym]` tracking entry (status: 'watching',
        // entryPrice/stop/t1/t2 set) BEFORE this buy attempt ran — that's
        // how the buy-alert Telegram message and rank/caution tags get
        // written. If the real MEXC order then fails, that entry must not
        // be left behind: exit-monitoring doesn't distinguish "actually
        // holding this" from "was tracked, buy failed" — it would go on to
        // watch price against that phantom entryPrice/stop and eventually
        // fire a real stop-loss or T1 alert for a coin that was never
        // actually bought. Safe to delete unconditionally here: a symbol
        // only reaches this point if it was a brand-new signal this cycle
        // (any pre-existing open position for it would have been skipped
        // earlier in leaderboard-decider.js, never reaching buy execution
        // at all) — so this is always the just-created watching entry,
        // never a real prior holding.
        delete positions[pick.sym];

        await sendTelegram(`🚨 *LIVE BUY FAILED* — ${symbol}\n  Error: ${e.message}\n  _No position opened on MEXC — tracking entry removed, no phantom stop/T1 alerts will follow. Check API key and USDT balance._`);
      }
    }
  }
}

// ── Single entry point the orchestrator calls ──
// ctx: { candidates, positions, market, tradeState, closedOutcomes, utc,
//        effectiveTradeMode, effectiveExecStrategy, effectiveTopNCount,
//        effectiveUsdSize, effectiveMaxLive, ranked, showRecoTags }
// Returns { changed } — whether `positions` was mutated (caller persists/pushes either way, but
// this lets the caller log/branch on it if desired).
export async function executeTradeCycle(ctx) {
  const { changed: rotationChanged } = await executeRotation(ctx);

  await executeAutoBuys(ctx);

  return { changed: rotationChanged };
}
