// ══════════════════════════════════════════════════════════════════════════════
// mexc-client.js — minimal signed REST client for MEXC Spot API v3
//
// Scope: exactly what leaderboard-decider.js needs for auto-trading —
// market buy (sized in USDT via quoteOrderQty), market sell (sized in base
// asset quantity), free-balance lookup, and lot-size precision lookup so
// sell quantities don't get rejected for too many decimals.
//
// CAUTION — verify against a small live order before trusting this at size:
//   MEXC's MARKET order response `price` field has been reported unreliable
//   (returns a stale/incorrect value, not the actual fill price — see
//   github.com/mexcdevelop/mexc-api-sdk/issues/77). This client always
//   derives fill price from cummulativeQuoteQty / executedQty instead of
//   trusting the `price` field on the order response.
// ══════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

const MEXC_BASE = 'https://api.mexc.com';

function sign(secret, query) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

function toQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

async function signedRequest(apiKey, apiSecret, method, endpoint, params = {}) {
  if (!apiKey || !apiSecret) throw new Error('MEXC API key/secret not configured');
  const query     = toQueryString({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const signature = sign(apiSecret, query);
  const url       = `${MEXC_BASE}${endpoint}?${query}&signature=${signature}`;

  const res  = await fetch(url, { method, headers: { 'X-MEXC-APIKEY': apiKey } });
  const body = await res.json().catch(() => ({}));

  // MEXC sometimes returns HTTP 200 with an error {code, msg} body — check both.
  if (!res.ok || (body && body.code && body.code !== 200)) {
    throw new Error(`MEXC ${method} ${endpoint} failed (HTTP ${res.status}): ${body?.msg || JSON.stringify(body)}`);
  }
  return body;
}

// Public endpoint — no signature needed. Cached per symbol for the lifetime
// of one Job B process (a fresh process each run, so this just avoids
// hitting it twice for the same symbol within a single cycle).
const _lotSizeCache = new Map();
export async function getBaseSizePrecision(symbol) {
  if (_lotSizeCache.has(symbol)) return _lotSizeCache.get(symbol);
  const res  = await fetch(`${MEXC_BASE}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json().catch(() => ({}));
  const info = (data.symbols || [])[0];

  // ── Root cause of the repeated IMX "quantity scale is invalid" HTTP 400s
  // (dev-team note "ST5 / ST15 Priority Buy & Multi-Alert Rotation" §7) ──
  // The old code always treated `baseSizePrecision` as a literal step size
  // (e.g. "0.01"). For a coarse/integer-only symbol MEXC can instead return
  // it as a bare decimal-PLACES count (e.g. "0" meaning "whole units
  // only"). parseFloat("0") is falsy, and floorToStep's `if (!step) return
  // qty` short-circuited on that — skipping rounding ENTIRELY and
  // submitting IMX's raw fractional balance to a symbol that only accepts
  // integers, every single cycle it was retried.
  //
  // Fix: detect a bare small integer string (0-8, no decimal point) and
  // treat THAT as a places-count (step = 10^-places, so "0" → step 1,
  // whole units); anything else is treated as the literal step size, as
  // before. Whatever happens, never let step end up falsy/zero — that's
  // exactly the bug. Whole-unit granularity (step=1) is always a SAFE
  // fallback (floors to an integer, which every symbol accepts) if nothing
  // usable came back from the exchange at all.
  let step = null;
  const raw = info?.baseSizePrecision;
  if (raw != null && raw !== '') {
    const rawStr = String(raw).trim();
    const val = parseFloat(rawStr);
    if (!isNaN(val)) {
      const looksLikePlacesCount = /^\d+$/.test(rawStr) && val <= 8;
      step = looksLikePlacesCount ? Math.pow(10, -val) : (val > 0 ? val : null);
    }
  }
  if (!step || step <= 0 || !isFinite(step)) step = 1;

  _lotSizeCache.set(symbol, step);
  return step;
}

// Floors DOWN to the exchange's allowed step size — never rounds up, since
// that could try to sell more than the wallet actually holds after fees.
export function floorToStep(qty, step) {
  if (!step || step <= 0) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  const factor    = Math.pow(10, precision);
  return Math.floor(qty * factor) / factor;
}

function deriveFillPrice(order) {
  const qty   = parseFloat(order.executedQty || '0');
  const quote = parseFloat(order.cummulativeQuoteQty || '0');
  // Prefer qty/quote (actual fill) — only fall back to the reported `price`
  // field if execution data isn't present, since that field is unreliable
  // for MARKET orders on MEXC.
  return qty > 0 && quote > 0 ? quote / qty : parseFloat(order.price || '0');
}

async function getOrder(apiKey, apiSecret, symbol, orderId) {
  return signedRequest(apiKey, apiSecret, 'GET', '/api/v3/order', { symbol, orderId });
}
// Exported wrapper — used by position-monitor.js to check whether a resting
// exchange-side stop order has already filled before attempting another sell.
export async function mexcGetOrderStatus(apiKey, apiSecret, symbol, orderId) {
  return getOrder(apiKey, apiSecret, symbol, orderId);
}

export async function mexcCancelOrder(apiKey, apiSecret, symbol, orderId) {
  return signedRequest(apiKey, apiSecret, 'DELETE', '/api/v3/order', { symbol, orderId });
}

// ── NOTE: exchange-side stop-loss removed ──
// MEXC's /api/v3/order endpoint only accepts type LIMIT or MARKET, and its
// documented parameter set has no stopPrice field and no OCO/stop endpoint
// anywhere in the spot v3 API. STOP_LOSS_LIMIT (Binance-compatible naming)
// is not a type MEXC has ever accepted — every call here failed with
// HTTP 400 "invalid type". Removed rather than left as dead/misleading code;
// the software stop check in position-monitor.js is the real stop mechanism.

// MEXC market order responses sometimes come back with executedQty and
// cummulativeQuoteQty both still 0 even though the order genuinely filled —
// the fill data just hasn't propagated to the API yet. If a caller trusts
// that initial 0 straight into positions.json, every later sell computes
// Math.min(0, freeBalance) = 0 regardless of what's actually in the wallet,
// which surfaces as a false "LIVE SELL SKIPPED — balance reads 0" even
// though the coins are sitting right there. This polls GET /api/v3/order a
// few times (400ms apart, ~2s total) until real fill data shows up.
async function pollForFill(apiKey, apiSecret, symbol, orderId, initialOrder) {
  let order = initialOrder;
  for (let i = 0; i < 5 && parseFloat(order.executedQty || '0') <= 0; i++) {
    await new Promise(r => setTimeout(r, 400));
    try {
      order = await getOrder(apiKey, apiSecret, symbol, orderId);
    } catch {
      break; // status check itself failed — fall through with last known data
    }
  }
  return order;
}

// Every non-zero crypto balance on the account, not just what positions.json
// happens to track — this is what lets rotation see a manually-bought coin
// (bought outside the bot, e.g. directly on MEXC) as a real open position.
export async function mexcGetAllBalances(apiKey, apiSecret) {
  const acct = await signedRequest(apiKey, apiSecret, 'GET', '/api/v3/account', {});
  return (acct.balances || [])
    .map(b => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
    .filter(b => (b.free + b.locked) > 0);
}

export async function mexcMarketBuy(apiKey, apiSecret, symbol, usdAmount) {
  let order = await signedRequest(apiKey, apiSecret, 'POST', '/api/v3/order', {
    symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: usdAmount,
  });
  if (parseFloat(order.executedQty || '0') <= 0 && order.orderId) {
    order = await pollForFill(apiKey, apiSecret, symbol, order.orderId, order);
  }
  let executedQty = parseFloat(order.executedQty || '0');
  let estimated = false;
  // Still 0 after polling — MEXC just hasn't reported fill data. Rather than
  // record a real qty of 0 (which silently disables all future stop/T2/
  // rotation sells for this position), fall back to a USD/price estimate so
  // there's at least a sellable quantity tracked, flagged as estimated so
  // callers can warn the user to verify it against the exchange.
  const fillPrice = deriveFillPrice(order);
  if (executedQty <= 0 && fillPrice > 0) {
    executedQty = usdAmount / fillPrice;
    estimated = true;
  }
  return {
    orderId: order.orderId,
    executedQty, fillPrice, estimated,
    raw: order,
  };
}

export async function mexcMarketSell(apiKey, apiSecret, symbol, quantity) {
  let order = await signedRequest(apiKey, apiSecret, 'POST', '/api/v3/order', {
    symbol, side: 'SELL', type: 'MARKET', quantity,
  });
  if (parseFloat(order.executedQty || '0') <= 0 && order.orderId) {
    order = await pollForFill(apiKey, apiSecret, symbol, order.orderId, order);
  }
  const executedQty = parseFloat(order.executedQty || '0') || quantity; // fall back to requested qty, never 0
  return {
    orderId:     order.orderId,
    executedQty,
    fillPrice:   deriveFillPrice(order),
    raw:         order,
  };
}

// withLocked=true returns { free, locked } instead of just the free number —
// useful right before a sell so a 0-free-balance skip can report whether the
// funds are actually sitting locked in another open order rather than truly
// absent (very different problems to diagnose on the exchange).
export async function mexcFreeBalance(apiKey, apiSecret, asset, withLocked = false) {
  const acct = await signedRequest(apiKey, apiSecret, 'GET', '/api/v3/account', {});
  const row  = (acct.balances || []).find(b => b.asset === asset);
  const free   = row ? parseFloat(row.free)   : 0;
  const locked = row ? parseFloat(row.locked) : 0;
  return withLocked ? { free, locked } : free;
}

// Account trade history for one symbol (most recent first from MEXC, we
// re-sort ascending by time so callers can walk it chronologically).
// Used by adoptManualHoldings to recover the REAL price a manual buy
// actually filled at, instead of falling back to whatever the market
// happens to be trading at when the next decide run notices the balance —
// those two can differ significantly (see MANUAL_ADOPTED cost-basis bug).
export async function mexcGetMyTrades(apiKey, apiSecret, symbol, limit = 50) {
  const trades = await signedRequest(apiKey, apiSecret, 'GET', '/api/v3/myTrades', { symbol, limit });
  return (Array.isArray(trades) ? trades : [])
    .map(t => ({
      price: parseFloat(t.price),
      qty:   parseFloat(t.qty),
      isBuyer: !!t.isBuyer,
      time:  t.time,
    }))
    .sort((a, b) => a.time - b.time);
}
