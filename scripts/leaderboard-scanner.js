// ══════════════════════════════════════════════════════════════════════════════
// leaderboard-scanner.js — v10.9
// Changes from v10.8:
//   - Imports resolveExchange / getMarketSession / toStooqSymbol from
//     exchange-registry.js — no more hardcoded suffix checks.
//   - scoreStock() now has a Stooq CSV fallback when Yahoo fails.
//     Provider order comes from exchange-registry providers.price array.
//   - exchangePrefix derived from registry (supports LSE, XETRA, TSE, HKEX, NSE).
//   - initYahoo() guard unchanged — called once per process.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveExchange, toStooqSymbol, buildSymKey } from './exchange-registry.js';
import { evaluateBuyReadiness, evaluateStockBuyReadiness, calcSpikeTrigger } from './buy-intelligence.js';
import { classifySignal, isBuyEligible } from './signal-evaluator.js';
import { runAllBuyGuards, checkBull4hPersistence, checkMarketIntelligenceGate } from './market-guard.js';
import { loadMarketData, loadMarketState, loadPositions } from './job-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED      = (process.env.TELEGRAM_ENABLED ?? 'true') === 'true';
const DRY_RUN         = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const LB_MIN_SCORE    = parseInt(process.env.LB_MIN_SCORE    || '9');
const LB_COOLDOWN_MIN = parseInt(process.env.LB_COOLDOWN_MIN || '60');
// NOTE: MOM WATCH (the lower-bar momentum heads-up alert) lives in
// leaderboard-decider.js, not here — runLeaderboardScanner() below is not
// invoked anywhere in alerts.yml's pipeline (only scoreSymbol/scoreStock
// are imported from this file, by market-fetcher.js). Adding the alert
// logic here would be dead code.
const STATE_PATH      = path.join(__dirname, '.lb-scan-state.json');
const WATCHLIST_PATH  = path.join(__dirname, '..', 'watchlist.json');

// ── Generic fetch with timeout ──
async function fetchJSON(url, headers = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(tid); }
}

async function fetchText(url, headers = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(tid); }
}

// ── Funding rate: Bybit → OKX → proxy-wrapped Bybit → Kraken → carry-forward ─────
// fapi.binance.com (funding rate / OI) is confirmed geo-blocked (HTTP 451)
// on GitHub-hosted runners, with no public spot-style mirror equivalent —
// data-api.binance.vision only serves spot. Bybit was added as the first
// fallback (same fix already working in alert-runner.js), but "carrying
// forward last known fr: 0.000%" on every symbol every cycle means Bybit
// is ALSO failing from this runner — likely the same class of datacenter
// geo-block/rate-limit exchanges commonly apply to derivatives endpoints,
// not just a Binance-specific issue. Rather than guess, this now logs the
// REAL underlying error (previous version swallowed it down to a generic
// "failed" message) and adds OKX as a second independent exchange, plus a
// CORS-proxy-wrapped retry of Bybit, before finally carrying forward.
//
// Kraken was added as a fourth, last-resort attempt specifically for pairs
// where Bybit/OKX/Bybit-proxy ALL consistently fail (observed: XMRUSDT and
// FETUSDT returning HTTP 403 on Bybit, "no data row" on OKX — see
// fetchKrakenFundingRate below for why this stays last-resort rather than
// an equal-weight source, and why it includes its own sanity guard).
const BYBIT_DIRECT = 'https://api.bybit.com';
const OKX_DIRECT    = 'https://www.okx.com';
const PROXY_PREFIX2 = 'https://corsproxy.io/?url=';

async function fetchBybitFundingRate(pair) {
  const url = `${BYBIT_DIRECT}/v5/market/tickers?category=linear&symbol=${pair}`;
  const d = await fetchJSON(url);
  if (d?.retCode !== undefined && d.retCode !== 0) throw new Error(`Bybit retCode ${d.retCode}: ${d.retMsg}`);
  const row = d?.result?.list?.[0];
  if (!row) throw new Error('Bybit: no ticker row returned');
  return parseFloat(row.fundingRate || 0) * 100;
}

// OKX uses instId format like "BTC-USDT-SWAP", not bare "BTCUSDT" —
// derive it from the pair (strip the USDT suffix, re-join with dashes).
async function fetchOkxFundingRate(pair) {
  const base   = pair.replace(/USDT$/, '');
  const instId = `${base}-USDT-SWAP`;
  const url = `${OKX_DIRECT}/api/v5/public/funding-rate?instId=${instId}`;
  const d = await fetchJSON(url);
  const row = d?.data?.[0];
  if (!row) throw new Error(`OKX: no data row for ${instId}`);
  return parseFloat(row.fundingRate || 0) * 100;
}

// Kraken Futures — last-resort fallback, used for symbols where Bybit/OKX
// (both geo-blocked from GH runners for some pairs, e.g. XMR/FET returning
// HTTP 403) consistently fail. Same "we already use Kraken for XMR on the
// GUI" data source, added server-side too.
//
// Two things make this a LAST resort rather than an equal-weight source,
// not just an ordering preference:
//   1. Kraken Futures perpetuals settle/fund roughly hourly, vs Bybit/OKX's
//      8-hour cycle — so even a correct Kraken reading isn't strictly
//      apples-to-apples with a Bybit/OKX-sourced `fr` on the same
//      thresholds (fundingHealthy <= 0.01%, position-monitor exit scoring).
//   2. Kraken's own feed shows real inconsistency between contract
//      families for the SAME asset: at the time this was written,
//      PF_XBTUSD read fundingRate 0.555 while PI_XBTUSD (also BTC) read
//      -0.00000000027 — many orders of magnitude apart. That's Kraken's
//      data, not a parsing bug on our end, so a bad PF_ reading for
//      XMR/FET is a real possibility, not a hypothetical.
// Given both of those, this includes a sanity guard: an implausible
// reading (>±5% per period, ~500x a typical healthy rate) is rejected
// outright rather than trusted, so it falls through to the existing
// carry-forward-last-known behavior instead of poisoning fundingHealthy
// or exit scoring with a garbage number.
const KRAKEN_FUTURES_DIRECT = 'https://futures.kraken.com';
const KRAKEN_SANITY_MAX_PCT = 5; // reject anything beyond ±5% per period

async function fetchKrakenFundingRate(pair) {
  const base   = pair.replace(/USDT$/, '');
  const symbol = `PF_${base}USD`; // Kraken Futures perpetual naming: PF_<BASE>USD
  const url = `${KRAKEN_FUTURES_DIRECT}/derivatives/api/v3/tickers`;
  const d = await fetchJSON(url);
  const row = d?.tickers?.find(t => t.symbol === symbol);
  if (!row) throw new Error(`Kraken: no ticker for ${symbol}`);
  if (row.fundingRate === undefined || row.fundingRate === null) {
    throw new Error(`Kraken: ${symbol} has no fundingRate field`);
  }
  const pct = parseFloat(row.fundingRate) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) > KRAKEN_SANITY_MAX_PCT) {
    throw new Error(`Kraken: ${symbol} fundingRate ${pct}% failed sanity check (>±${KRAKEN_SANITY_MAX_PCT}%) — rejecting, not trusting`);
  }
  return pct;
}

async function fetchFundingRate(pair) {
  const attempts = [
    { name: 'Bybit',        fn: () => fetchBybitFundingRate(pair) },
    { name: 'OKX',          fn: () => fetchOkxFundingRate(pair) },
    { name: 'Bybit(proxy)', fn: () => fetchJSON(`${PROXY_PREFIX2}${encodeURIComponent(`${BYBIT_DIRECT}/v5/market/tickers?category=linear&symbol=${pair}`)}`).then(d => {
        const row = d?.result?.list?.[0];
        if (!row) throw new Error('Bybit(proxy): no ticker row returned');
        return parseFloat(row.fundingRate || 0) * 100;
      }) },
    { name: 'Kraken',       fn: () => fetchKrakenFundingRate(pair) },
  ];
  const errors = [];
  for (const a of attempts) {
    try { return await a.fn(); }
    catch (e) { errors.push(`${a.name}: ${e.message}`); }
  }
  throw new Error(errors.join(' | '));
}

// ── Binance fetch with mirror → direct → proxy fallback ──
const BINANCE_MIRROR = 'https://data-api.binance.vision';
const BINANCE_DIRECT = 'https://api.binance.com';
const PROXY_PREFIX   = 'https://corsproxy.io/?url=';

async function fetchBinance(urlPath, { useMirror = true } = {}) {
  const candidates = [];
  if (useMirror) candidates.push(`${BINANCE_MIRROR}${urlPath}`);
  candidates.push(`${BINANCE_DIRECT}${urlPath}`);
  let lastErr = null;
  for (const url of candidates) {
    try { return await fetchJSON(url); } catch (e) { lastErr = e; }
  }
  try {
    return await fetchJSON(`${PROXY_PREFIX}${encodeURIComponent(`${BINANCE_DIRECT}${urlPath}`)}`);
  } catch (e) { lastErr = e; }
  throw lastErr || new Error('all Binance endpoints failed');
}

// ── Yahoo Finance session ──
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let yahooCookie = '';
let yahooCrumb  = '';
let yahooInited = false;

export async function initYahoo() {
  if (yahooInited) return;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YAHOO_UA }, redirect: 'follow',
    });
    const cookieMatch = (r1.headers.get('set-cookie') || '').match(/(A\d=[^;]+)/);
    yahooCookie = cookieMatch ? cookieMatch[1] : '';
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
    });
    yahooCrumb = await r2.text();
    if (!yahooCrumb || yahooCrumb.includes('<') || yahooCrumb.length >= 50) {
      console.log('  ⚠  Yahoo crumb unexpected — Stooq fallback will be used');
      yahooCrumb = '';
    } else {
      console.log(`  📡  Yahoo session ready (crumb ${yahooCrumb.length} chars)`);
    }
  } catch (e) {
    console.log('  ⚠  Yahoo init failed:', e.message);
  }
  yahooInited = true;
}

function yahooHeaders() {
  return { 'User-Agent': YAHOO_UA, Cookie: yahooCookie, Accept: 'application/json' };
}

// ── Batched live quote fetch (v7/finance/quote) ──────────────────────────
// The v8/finance/chart endpoint used for daily bars does NOT reliably carry
// pre/post-market prices (confirmed empty in production) and its
// chartPreviousClose field doesn't line up with the actual daily-bar series
// (produced 16-21% phantom % moves when tried). v7/finance/quote is Yahoo's
// dedicated live-quote endpoint — it's built for exactly this and exposes
// ready-made regularMarketChangePercent/preMarketChangePercent/
// postMarketChangePercent fields directly, so there's no manual
// previous-close arithmetic to get wrong. One batched call for every stock
// symbol at once (not per-symbol), cached for the life of this process run.
const _yahooQuoteCache = new Map(); // bare ticker -> quote fields

export async function primeYahooQuotes(syms) {
  const bareList = [...new Set(
    syms.map(s => s.includes(':') ? s.split(':').slice(1).join(':') : s)
  )];
  if (!bareList.length) return;
  const crumbSuffix = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
  try {
    const d = await fetchJSON(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${bareList.join(',')}${crumbSuffix}`,
      yahooHeaders()
    );
    const results = d?.quoteResponse?.result || [];
    for (const q of results) {
      if (!q?.symbol) continue;
      _yahooQuoteCache.set(q.symbol.toUpperCase(), {
        regularMarketPrice:        q.regularMarketPrice,
        regularMarketChangePercent: q.regularMarketChangePercent,
        preMarketPrice:            q.preMarketPrice,
        preMarketChangePercent:    q.preMarketChangePercent,
        postMarketPrice:           q.postMarketPrice,
        postMarketChangePercent:   q.postMarketChangePercent,
        marketState:               q.marketState,
      });
    }
    console.log(`  📡  Yahoo live quotes: ${results.length}/${bareList.length} symbols`);
  } catch (e) {
    console.log('  ⚠  Yahoo batched quote fetch failed:', e.message, '— stocks will use daily-bar close as before');
  }
}

// Live price/% for one symbol, or null if this ticker isn't in the cache
// (batch fetch failed, or wasn't primed) — caller falls back to daily bars.
function getLiveQuote(sym) {
  const bare = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
  const q = _yahooQuoteCache.get(bare.toUpperCase());
  if (!q) return null;
  // Prefer the most "extended" session that actually has data: post > pre > regular.
  if (q.marketState === 'POST' && typeof q.postMarketPrice === 'number' && typeof q.postMarketChangePercent === 'number') {
    return { price: q.postMarketPrice, chg: parseFloat(q.postMarketChangePercent.toFixed(2)) };
  }
  if (q.marketState === 'PRE' && typeof q.preMarketPrice === 'number' && typeof q.preMarketChangePercent === 'number') {
    return { price: q.preMarketPrice, chg: parseFloat(q.preMarketChangePercent.toFixed(2)) };
  }
  if (typeof q.regularMarketPrice === 'number' && typeof q.regularMarketChangePercent === 'number') {
    return { price: q.regularMarketPrice, chg: parseFloat(q.regularMarketChangePercent.toFixed(2)) };
  }
  return null;
}

// ── Stooq CSV fetch → returns bars[] same shape as Yahoo path ──
// Stooq CSV format: Date,Open,High,Low,Close,Volume
async function fetchStooqBars(sym) {
  const stooqSym = toStooqSymbol(sym);
  if (!stooqSym) throw new Error(`no Stooq symbol mapping for ${sym}`);

  // d = daily, 3-month window
  const url = `https://stooq.com/q/d/l/?s=${stooqSym}&i=d`;
  const csv = await fetchText(url, {}, 10000);

  const lines = csv.trim().split('\n').slice(1); // skip header
  if (!lines.length || lines[0].startsWith('No data')) {
    throw new Error(`Stooq returned no data for ${stooqSym}`);
  }

  const bars = [];
  for (const line of lines) {
    const [, o, h, l, c, v] = line.split(',');
    const close = parseFloat(c), open = parseFloat(o), vol = parseFloat(v) || 0;
    if (!isNaN(close) && !isNaN(open)) {
      bars.push({ c: close, o: open, h: parseFloat(h) || close, l: parseFloat(l) || close, v: vol });
    }
  }
  if (bars.length < 10) throw new Error(`Stooq: only ${bars.length} bars for ${stooqSym}`);
  return bars;
}

// ── Yahoo bars fetch ──
async function fetchYahooBars(sym) {
  // Yahoo's chart API wants the bare ticker only — no exchange prefix
  // (NASDAQ:NVDA → NVDA). Suffix-based tickers (.TO, .L, .DE …) are passed
  // through unchanged since Yahoo expects those as-is.
  const bare = sym.includes(':') ? sym.split(':').slice(1).join(':') : sym;
  const crumbSuffix = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
  const d = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${bare}?interval=1d&range=3mo&includePrePost=true${crumbSuffix}`,
    yahooHeaders()
  );
  const r  = d.chart.result[0];
  const qi = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < qi.close.length; i++) {
    if (qi.close[i] != null && qi.open[i] != null) {
      bars.push({
        c: qi.close[i],
        o: qi.open[i],
        h: qi.high?.[i] ?? qi.close[i],
        l: qi.low?.[i]  ?? qi.close[i],
        v: qi.volume?.[i] ?? 0,
      });
    }
  }
  if (bars.length < 10) throw new Error(`Yahoo: only ${bars.length} bars`);
  // meta carries Yahoo's live quote fields (same response, previously
  // discarded) — regularMarketPrice always present; pre/postMarketPrice
  // only present when that session's data is actually available.
  return { bars, meta: r.meta || null };
}

// ── Fetch bars with provider fallback chain from registry ──
// Returns { bars, meta } — meta is Yahoo's live quote block (null for the
// Stooq fallback, which is delayed daily-CSV only and has no live/extended
// -hours concept).
async function fetchStockBars(sym) {
  const ex        = resolveExchange(sym);
  const providers = ex?.providers?.price ?? ['yahoo', 'stooq'];
  let lastErr     = null;

  for (const provider of providers) {
    try {
      if (provider === 'yahoo') {
        const { bars, meta } = await fetchYahooBars(sym);
        console.log(`  📥  ${sym} bars via Yahoo (${bars.length} days)`);
        return { bars, meta };
      }
      if (provider === 'stooq') {
        const bars = await fetchStooqBars(sym);
        console.log(`  📥  ${sym} bars via Stooq fallback (${bars.length} days)`);
        return { bars, meta: null };
      }
    } catch (e) {
      console.log(`  ⚠  ${sym} ${provider} failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error(`all providers failed for ${sym}`);
}

// ── State ──
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function isOnCooldown(state, key) {
  const ts = state[key] || 0;
  return (Date.now() - ts) < LB_COOLDOWN_MIN * 60000;
}
function markCooldown(state, key) { state[key] = Date.now(); }

async function sendTelegram(msg) {
  if (DRY_RUN)     { console.log('[DRY-RUN] TG:', msg.slice(0, 80)); return; }
  if (!TG_ENABLED) { console.log('[TG DISABLED]'); return; }
  if (!TG_TOKEN || !TG_CHAT) { console.warn('⚠ No TG credentials'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' }),
    });
    const d = await r.json();
    if (!d.ok) console.warn('TG error:', d.description);
  } catch (e) { console.warn('TG fetch error:', e.message); }
}

// ════════════════════════════════════════════════════════
// SIGNAL MATH (unchanged from v10.8)
// ════════════════════════════════════════════════════════

function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i-1]; g += d > 0 ? d : 0; l += d < 0 ? -d : 0; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (p-1) + (d > 0 ? d : 0)) / p;
    al = (al * (p-1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// Proxy CVD (no real trade-level buy/sell volume feed — see note in
// market-intelligence.js's calcOiMomentum for the same class of tradeoff).
// Previously just a majority vote over the last 6 15m candles (4+ red =
// 'down', otherwise 'up') — a 4-red/2-green count and a 6-red/0-green count
// scored identically in calcConviction, same "binary flag with no
// magnitude" problem calcOiMomentum had before the rawSlope fix. Now also
// returns strength: the summed % net body move across those 6 candles, so
// calcConviction can scale its reward/penalty instead of treating every
// 'up'/'down' read as equally strong.
function calcCVD(k15m) {
  if (!k15m || k15m.length < 6) return { trend: 'up', strength: 0 };
  const last6 = k15m.slice(-6);
  const netBias = last6.reduce((sum, c) => {
    const open = parseFloat(c[1]), close = parseFloat(c[4]);
    return sum + (open > 0 ? (close - open) / open : 0);
  }, 0) * 100; // signed sum of %-returns across 6 candles, in percentage points
  return { trend: netBias >= 0 ? 'up' : 'down', strength: parseFloat(Math.abs(netBias).toFixed(3)) };
}

// ── 15m Supertrend(period,multiplier) — closed candles only ──────────────
// Per the "15m Supertrend Priority Execution" dev-team note: this is a
// SEPARATE entry-timing signal from calcConviction/calcSpikeTrigger above,
// consumed by leaderboard-decider.js as a Priority-0 execution path (an
// independent gate that bypasses normal strategy qualification, not a
// score input) — never folded into d.conv/calcConviction. Standard
// Supertrend: ATR(period) (Wilder-smoothed) sets basic upper/lower bands
// around the (high+low)/2 midpoint; the "sticky" final bands only ever
// tighten toward price (never widen back out) until price actually closes
// through the opposite band, at which point direction flips. The dev note
// explicitly requires CLOSED candles only — never the still-forming last
// candle — so a still-forming bar is dropped here based on its own open
// time + the interval length, rather than trusting array position (k15's
// last element is the CURRENTLY forming candle whenever Job A's fetch
// lands mid-candle, which is most of the time on a 5-min fetch cadence
// against 15m candles).
const ST15_INTERVAL_MS = 15 * 60 * 1000;
const ST5_INTERVAL_MS  = 5  * 60 * 1000;
function calcSupertrend(k15, period = 10, multiplier = 3, intervalMs = ST15_INTERVAL_MS) {
  if (!k15 || !k15.length) return null;
  const nowMs  = Date.now();
  const closed = k15.filter(c => (parseInt(c[0], 10) + intervalMs) <= nowMs);
  const n = closed.length;
  // Needs period bars to seed ATR, plus 2 more closed bars so a
  // previous-vs-current direction comparison (the cross itself) is
  // possible, plus SLOPE_LOOKBACK more so the slope/barsSinceCross
  // enrichment below has real history to look back over (falls back to
  // whatever's available if a symbol has fewer bars than ideal — those
  // fields degrade gracefully to null/0 rather than the whole calc
  // failing, since the core Supertrend value/direction are still valid
  // and more valuable than the enrichment on top of them).
  if (n < period + 2) return null;

  const highs  = closed.map(c => parseFloat(c[2]));
  const lows   = closed.map(c => parseFloat(c[3]));
  const closes = closed.map(c => parseFloat(c[4]));

  const tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    tr[i] = i === 0
      ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }

  const atr = new Array(n).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  atr[period - 1] = seed / period; // Wilder seed = simple average of first `period` TRs
  for (let i = period; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;

  const upperBand = new Array(n).fill(null);
  const lowerBand = new Array(n).fill(null);
  const st        = new Array(n).fill(null);
  const dir       = new Array(n).fill(null); // 'BULL' | 'BEAR'

  for (let i = period - 1; i < n; i++) {
    if (atr[i] == null) continue;
    const mid         = (highs[i] + lows[i]) / 2;
    const basicUpper  = mid + multiplier * atr[i];
    const basicLower  = mid - multiplier * atr[i];
    const prevUpper   = upperBand[i - 1];
    const prevLower   = lowerBand[i - 1];
    const prevClose   = closes[i - 1];

    // Sticky bands — only move toward price, except when price closes
    // through the opposite band (standard Supertrend behavior).
    upperBand[i] = (prevUpper != null && basicUpper >= prevUpper && prevClose <= prevUpper) ? prevUpper : basicUpper;
    lowerBand[i] = (prevLower != null && basicLower <= prevLower && prevClose >= prevLower) ? prevLower : basicLower;

    if (i === period - 1) {
      dir[i] = closes[i] >= upperBand[i] ? 'BULL' : 'BEAR';
    } else {
      const prevDir = dir[i - 1];
      dir[i] = prevDir === 'BULL'
        ? (closes[i] < lowerBand[i] ? 'BEAR' : 'BULL')
        : (closes[i] > upperBand[i] ? 'BULL' : 'BEAR');
    }
    st[i] = dir[i] === 'BULL' ? lowerBand[i] : upperBand[i];
  }

  const last = n - 1, prev = n - 2;
  if (dir[last] == null || dir[prev] == null || st[last] == null) return null;

  const crossUp = dir[prev] === 'BEAR' && dir[last] === 'BULL';
  const stVal   = st[last];
  const atrVal  = atr[last]; // already computed above, just wasn't returned before

  // ── ST5/ST15 TIMING ENGINE ENRICHMENT ──────────────────────────────────
  // Per the "ST5/ST15 Timing Engine" dev-team doc (§2-§4): ATR-normalized
  // distance/extension, slope, bars-since-cross, and candle-impulse — used
  // downstream by st-timing-engine.js as a P2 entry-timing/falling-knife/
  // exhaustion layer, kept entirely separate from conviction scoring.
  // distanceATR is SIGNED: positive = price above the ST line (normal for
  // BULL), negative = price below it (normal for BEAR, or an early warning
  // inside a BULL run). Extension zone below uses the absolute value.
  const distanceATR = atrVal > 0 ? parseFloat(((closes[last] - stVal) / atrVal).toFixed(3)) : null;

  const STZ_GOOD  = parseFloat(process.env.ST_ATR_ZONE_GOOD  || '0.75'); // 0–this   = GOOD_ENTRY
  const STZ_EXT   = parseFloat(process.env.ST_ATR_ZONE_EXT   || '1.25'); // this–below = EXTENDED
  const STZ_VEXT  = parseFloat(process.env.ST_ATR_ZONE_VEXT  || '2.0');  // this–below = VERY_EXTENDED, above = EXHAUSTED
  let extensionZone = null;
  if (distanceATR != null) {
    const absD = Math.abs(distanceATR);
    extensionZone = absD <= STZ_GOOD ? 'GOOD_ENTRY'
                  : absD <= STZ_EXT  ? 'EXTENDED'
                  : absD <= STZ_VEXT ? 'VERY_EXTENDED'
                                     : 'EXHAUSTED';
  }

  // barsSinceCross — consecutive closed bars (including the current one)
  // holding the same direction as `last`. Caps the backward scan at the
  // full series rather than assuming SLOPE_LOOKBACK bars exist.
  let barsSinceCross = 1;
  for (let i = last - 1; i >= period - 1 && dir[i] === dir[last]; i--) barsSinceCross++;

  // slope — ST line movement over the last SLOPE_LOOKBACK closed bars,
  // normalized to ATR units per bar so it's comparable across symbols of
  // very different price scale. Falls back to null if not enough bars
  // exist yet (new-ish symbol / early in the fetched window) rather than
  // computing a misleading slope off too few points.
  const SLOPE_LOOKBACK = parseInt(process.env.ST_SLOPE_LOOKBACK || '3', 10);
  const slopeIdx = last - SLOPE_LOOKBACK;
  let slope = null, slopeStrength = null;
  // dir[slopeIdx] === dir[last] guards against a band-switch artifact: st[]
  // tracks lowerBand while BULL and upperBand while BEAR (see st[i] assignment
  // above), so diffing across a direction flip subtracts two different bands
  // (e.g. new lowerBand − old upperBand) rather than measuring the same
  // line's movement. That produces a large, mechanically-guaranteed negative
  // delta on almost every fresh cross-up (regardless of real momentum), which
  // was getting misread downstream as a "strongly negative slope" falling-
  // knife signal on legitimate fresh crosses. Requiring the lookback bar to
  // be in the SAME direction as `last` makes slope correctly fall back to
  // null (no penalty) until there's enough same-regime history — consistent
  // with this function's existing "fall back to null rather than compute a
  // misleading slope" policy.
  if (slopeIdx >= period - 1 && st[slopeIdx] != null && dir[slopeIdx] === dir[last] && atrVal > 0) {
    slope = parseFloat(((stVal - st[slopeIdx]) / SLOPE_LOOKBACK / atrVal).toFixed(4));
    const absSlope = Math.abs(slope);
    const SLOPE_WEAK   = parseFloat(process.env.ST_SLOPE_WEAK_MAX   || '0.05');
    const SLOPE_STRONG = parseFloat(process.env.ST_SLOPE_STRONG_MIN || '0.15');
    slopeStrength = absSlope < SLOPE_WEAK ? 'WEAK' : absSlope >= SLOPE_STRONG ? 'STRONG' : 'NORMAL';
  }

  // candleImpulseATR — the most recent closed candle's full range relative
  // to ATR. A large value (big green/red candle) is the "detect chasing"
  // signal from §2's st5CandleImpulse — an EXTENDED/VERY_EXTENDED zone
  // reached via one huge candle is a much worse entry than the same zone
  // reached gradually.
  const candleImpulseATR = atrVal > 0 ? parseFloat(((highs[last] - lows[last]) / atrVal).toFixed(3)) : null;

  // retest — did price recently push into EXTENDED-or-worse territory and
  // then pull back toward the ST line while direction held (no flip), and
  // is now turning back up? This is a heuristic over the last
  // RETEST_LOOKBACK closed bars, not a strict pattern match — the doc
  // explicitly flags entry-timing thresholds as needing backtesting before
  // being fixed; this gives a reasonable starting definition rather than
  // leaving retest permanently false.
  const RETEST_LOOKBACK = parseInt(process.env.ST_RETEST_LOOKBACK || '6', 10);
  let retest = false;
  if (distanceATR != null && extensionZone === 'GOOD_ENTRY' && dir[last] === 'BULL') {
    const from = Math.max(period - 1, last - RETEST_LOOKBACK);
    let pushedExtended = false;
    for (let i = from; i < last; i++) {
      if (atr[i] > 0 && dir[i] === 'BULL') {
        const d = Math.abs((closes[i] - st[i]) / atr[i]);
        if (d > STZ_GOOD) { pushedExtended = true; break; }
      }
    }
    retest = pushedExtended && closes[last] >= closes[last - 1];
  }

  // consolidation — P2-B (Consolidation Breakout) support, per the
  // "P2 Continuation Strategy" dev doc §4-5 (UNI-style second leg): was a
  // tight sideways range formed over the last P2B_RANGE_LOOKBACK CLOSED
  // bars, and did THIS closed candle break above that range's high? The
  // range window explicitly EXCLUDES the current bar (`last`) — per the
  // doc's guardrail table ("exclude the current candle from the level
  // calculation") — so recomputing this every cycle can never let a rolling
  // level treat every candle above it as a fresh breakout; the range itself
  // only shifts once the breakout bar itself ages out of the lookback on a
  // later cycle. `breakout` is decided on CLOSE, not high/low, so a
  // wick-only poke above the range never qualifies (doc §5: "wick-only
  // breaks do not qualify"). Only meaningful in a BULL regime — left null
  // otherwise, same graceful-degradation pattern as `retest` above.
  const P2B_RANGE_LOOKBACK = parseInt(process.env.P2B_RANGE_LOOKBACK || '5', 10);
  const P2B_WIDTH_ATR_MAX  = parseFloat(process.env.P2B_CONSOLIDATION_ATR_MAX || '1.5');
  let consolidation = null;
  if (dir[last] === 'BULL' && atrVal > 0) {
    const rangeFrom = last - P2B_RANGE_LOOKBACK; // excludes current candle
    if (rangeFrom >= period - 1) {
      const rangeHigh = Math.max(...highs.slice(rangeFrom, last));
      const rangeLow  = Math.min(...lows.slice(rangeFrom, last));
      const widthATR  = parseFloat(((rangeHigh - rangeLow) / atrVal).toFixed(3));
      const detected  = widthATR <= P2B_WIDTH_ATR_MAX;
      const breakout  = detected && closes[last] > rangeHigh;
      consolidation = {
        detected, breakout,
        bars:      P2B_RANGE_LOOKBACK,
        rangeHigh: parseFloat(rangeHigh.toFixed(8)),
        rangeLow:  parseFloat(rangeLow.toFixed(8)),
        widthATR,
      };
    }
  }

  return {
    period, multiplier,
    value:              parseFloat(stVal.toFixed(8)),
    direction:          dir[last],
    previousDirection:  dir[prev],
    crossUp,
    close:              closes[last],
    lastClosedCandle:   new Date(parseInt(closed[last][0], 10)).toISOString(),
    distancePct:        stVal > 0 ? parseFloat((((closes[last] - stVal) / stVal) * 100).toFixed(3)) : 0,
    // ── timing-engine enrichment (all additive, backward-compatible) ──
    atr:                atrVal != null ? parseFloat(atrVal.toFixed(8)) : null,
    distanceATR,
    extensionZone,      // 'GOOD_ENTRY' | 'EXTENDED' | 'VERY_EXTENDED' | 'EXHAUSTED' | null
    barsSinceCross,
    slope,              // ATR units per bar, signed
    slopeStrength,      // 'WEAK' | 'NORMAL' | 'STRONG' | null
    candleImpulseATR,
    retest,
    consolidation,      // { detected, breakout, bars, rangeHigh, rangeLow, widthATR } | null — P2-B support
  };
}

function calcOBI(depth) {
  if (!depth) return 0;
  const bidVol = (depth.bids || []).slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
  const askVol = (depth.asks || []).slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
  const total  = bidVol + askVol;
  return total > 0 ? ((bidVol - askVol) / total * 100) : 0;
}

// Full EMA series (not just the final value) — needed to derive MACD,
// which requires an EMA-of-an-EMA-derived-series, not a single number.
function emaSeries(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// MACD(12,26,9) histogram — last value only. Returns null if there isn't
// enough history for a stable signal line (needs ~35+ bars); callers must
// treat null as "unknown", not as bearish/bullish.
function calcMACDHistogram(closes) {
  if (!closes || closes.length < 35) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = [];
  for (let i = 25; i < closes.length; i++) macdLine.push(ema12[i] - ema26[i]);
  if (macdLine.length < 9) return null;
  const signal = emaSeries(macdLine, 9);
  const lastSignal = signal[signal.length - 1];
  if (lastSignal === undefined) return null;
  return macdLine[macdLine.length - 1] - lastSignal;
}

// ── 4h bias — weighted score, not a rigid 2-factor AND-gate ────────────
// The old version (price>EMA20 && RSI4h>50 → BULL, else piecewise) could
// stay pinned to BEAR/LEAN BEAR for hours during a fast V-shaped recovery,
// because EMA20 (a lagging average) hadn't caught up to price yet even
// once RSI, MACD, and the EMA's own slope had already turned bullish.
//
// price vs EMA20 stays the one SYMMETRIC (bidirectional ±2) factor — it's
// the primary structural trend read this gate is built to trust. Every
// other factor is BONUS-ONLY (adds when true, never subtracts when
// false) — deliberately, so a recovery with strong confirming momentum
// (RSI>55 and rising, MACD flipped positive, EMA20 itself turning up)
// can out-vote a not-yet-reclaimed EMA20 and reach NEUTRAL 4H (which does
// NOT block buys) instead of staying floored at LEAN BEAR/BEAR 4H.
// Score range: -2 (nothing bullish at all) .. +7 (everything aligned).
function calc4hBias(k4h) {
  if (!k4h || k4h.length < 20) return '—';
  const closes = k4h.map(c => parseFloat(c[4]));
  const price  = closes[closes.length - 1];

  const ema20     = calcEMA(closes, 20);
  const ema20Prev = calcEMA(closes.slice(0, -1), 20);
  const ema50     = closes.length >= 50 ? calcEMA(closes, 50) : null;
  const r4h       = calcRSI(closes);
  const r4hPrev   = calcRSI(closes.slice(0, -1));
  const macdHist  = calcMACDHistogram(closes);

  if (!ema20) return '—';

  let score = price > ema20 ? 2 : -2;                          // symmetric anchor
  if (ema20Prev !== null && ema20 > ema20Prev) score += 1;      // EMA20 rising (bonus only)
  if (r4h > 55)                                score += 1;      // bonus only
  if (r4hPrev !== null && r4h > r4hPrev)       score += 1;      // RSI rising (bonus only)
  if (macdHist !== null && macdHist > 0)       score += 1;      // bonus only
  if (ema50 !== null && price > ema50)         score += 1;      // bonus only — never penalizes a not-yet-reclaimed EMA50

  if (score >= 6)  return 'BULL 4H';
  if (score >= 4)  return 'LEAN BULL';
  if (score >= 1)  return 'NEUTRAL 4H';
  if (score >= -1) return 'LEAN BEAR';
  return 'BEAR 4H';
}

function calcDailyBias(kDay) {
  if (!kDay || kDay.length < 5) return '—';
  const closes = kDay.map(c => parseFloat(c[4]));
  const ema10  = calcEMA(closes, Math.min(10, closes.length));
  const price  = closes[closes.length - 1];
  const r1d    = calcRSI(closes);
  if (!ema10) return '—';
  if (price > ema10 && r1d > 50) return 'BULL DAY';
  if (price < ema10 && r1d < 50) return 'BEAR DAY';
  return price > ema10 ? 'LEAN BULL' : 'LEAN BEAR';
}

export function getSetupMode(d) {
  const shock    = d.shock || 1;
  const frNum    = d.fr    || 0;
  const conv     = d.conv  || 0;
  const cvdUp    = d.cvdTrend === 'up';
  const emaAbove = d.emaTrend === 'ABOVE';
  if (d.oiDiv === 'DIP BUY' && frNum <= -0.01)  return { label: 'DIP BUY',     emoji: '💎' };
  if (shock >= 2.0 && cvdUp && conv > 6)         return { label: 'SQUEEZE NOW', emoji: '🚀' };
  if (emaAbove && conv > 5)                      return { label: 'BREAKOUT',    emoji: '⚡' };
  if (conv < -4)                                 return { label: 'SHORT SETUP', emoji: '🔻' };
  return { label: 'WATCHING', emoji: '⏳' };
}

function calcEntryLevels(price, shock) {
  const p = parseFloat(price) || 0;
  if (!p) return null;
  const atr   = p * 0.015 * Math.max(1, shock * 0.5);
  const dp    = p < 10 ? 4 : 2;
  // Entry = current price, no chase markup. All buys execute as MEXC MARKET
  // orders anyway (fills near-instantly at whatever price is live) — the old
  // +0.4% markup didn't change what got paid, it just inflated the reference
  // entry used to anchor stop/rr math, making the effective risk-per-trade
  // wider than STOP_LOSS_PCT implied. See mexc-trader.js executeAutoBuys()
  // for the post-fill resync that anchors stop/t1/t2 to the REAL fill price.
  const entry = p.toFixed(dp);
  const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.1'); // fixed %, not volatility-scaled — kept in sync with leaderboard-decider.js
  const stop  = (p * (1 - STOP_LOSS_PCT / 100)).toFixed(dp);
  const t1    = (p + atr * 2).toFixed(dp);
  const t2    = (p + atr * 4).toFixed(dp);
  const rr    = (parseFloat(t1) - parseFloat(entry)) / (parseFloat(entry) - parseFloat(stop));
  return { entry, stop, t1, t2, rr: isFinite(rr) ? rr.toFixed(1) : '—' };
}

export function calcConviction(d) {
  let score = 0;
  const chg     = d.chg      || 0;
  const shock   = d.shock    || 1;
  const obi     = d.obi      || 0;
  const cvdUp   = d.cvdTrend === 'up';
  const cvdStrength = d.cvdStrength ?? 0; // % net body move across last 6 15m candles — 0 if unavailable (falls back to old flat scoring)
  const r15     = d.r15      || 50;
  const r4h     = d.r4h      || 50;
  const fr      = d.fr       || 0;
  const bias4h  = d.bias4h   || '—';
  const biasDay = d.biasDay  || '—';
  const ema     = d.emaTrend || '—';

  if (chg > 1.5) score += 2; else if (chg > 0.5) score += 1;
  else if (chg < -1.5) score -= 2; else if (chg < -0.5) score -= 1;
  if (shock > 1.6) score += 1;
  if (obi > 20) score += 2; else if (obi > 5) score += 1;
  else if (obi < -20) score -= 2; else if (obi < -5) score -= 1;
  // Magnitude-scaled, not a flat +2/-1 flag — same fix already applied to
  // oiMomentum's rawSlope/frTrendLabel (calcOiMomentum used to blow up on
  // a near-zero mean; this one just had zero magnitude awareness at all,
  // so a 4-red/2-green candle count scored identically to 6-red/0-green).
  // cvdStrength is the summed %-move across the last 6 15m candles.
  // Scaled to roughly the old range (was flat +2/-1) but now 0.1%
  // strength gets barely more than the base, while a strong 1%+ net move
  // gets close to double the old flat reward.
  const cvdScore   = Math.min(3, 1 + cvdStrength * 0.4);   // reward when up
  const cvdPenalty = Math.min(2, 0.5 + cvdStrength * 0.3); // penalty when down — capped lower than the reward (this is a bull-only system, so a down CVD read matters less than a strong up one)
  if (cvdUp) score += cvdScore; else score -= cvdPenalty;
  // Independent per-timeframe dip-buy reward — the old version required
  // BOTH r15<30 AND r4h<35 simultaneously, the same all-or-nothing gating
  // already fixed on the extension-penalty side below (r15>70 / r4h>65
  // used to be AND-gated too, now independent). Keeping the reward side
  // AND-gated while the penalty side was loosened was inconsistent.
  if (r15 < 30) score += 1;
  if (r4h < 35) score += 1;
  // Independent per-timeframe extension penalty — the old version
  // (`r15 > 70 && r4h > 65`) required BOTH timeframes hot simultaneously,
  // so a symbol extended on the entry timeframe alone (e.g. r15=72,
  // r4h=55) took zero penalty. See buy-intelligence.js's
  // calcEntryExtension for the fuller independent per-timeframe version
  // applied on top of this in scoreSymbol — this stays as calcConviction's
  // own baseline so the function is still meaningful used standalone.
  if (r15 > 70) score -= 1;
  if (r4h > 65) score -= 1;
  if (ema === 'ABOVE') score += 1; else if (ema === 'BELOW') score -= 1;
  if (fr <= -0.03) score += 2; else if (fr <= -0.01) score += 1;
  else if (fr >= 0.05) score -= 2; else if (fr >= 0.025) score -= 1;
  if (d.oiDiv === 'DIP BUY') score += 2;
  else if (d.oiDiv === 'CONFIRM') score += 1;
  else if (d.oiDiv === 'OI DROP') score -= 1;
  if (bias4h.includes('BULL 4H')) score += 2;
  else if (bias4h.includes('LEAN BULL')) score += 1;
  else if (bias4h.includes('BEAR 4H')) score -= 2;
  else if (bias4h.includes('LEAN BEAR')) score -= 1;
  if (biasDay.includes('BULL DAY')) score += 1;
  else if (biasDay.includes('BEAR DAY')) score -= 1;
  return Math.round(score);
}

export function calcWhaleScore(d) {
  const fr    = d.fr    || 0;
  const shock = d.shock || 1;
  const obi   = d.obi   || 0;
  const cvdUp = d.cvdTrend === 'up';
  const oiDiv = d.oiDiv || 'NEUTRAL';
  let raw = 50;
  if      (oiDiv === 'DIP BUY') raw += 25;
  else if (oiDiv === 'CONFIRM') raw += 18;
  else if (oiDiv === 'OI DROP') raw -= 15;
  if (cvdUp) raw += 20; else raw -= 20;
  if      (obi > 20)  raw += 15; else if (obi > 5)   raw += 8;
  else if (obi < -20) raw -= 15; else if (obi < -5)  raw -= 8;
  if      (fr <= -0.03) raw += 15; else if (fr <= -0.01) raw += 8;
  else if (fr >= 0.05)  raw -= 15; else if (fr >= 0.025) raw -= 8;
  if      (shock >= 2.5) raw += 15; else if (shock >= 1.8) raw += 10;
  else if (shock >= 1.3) raw += 5;  else if (shock < 0.7)  raw -= 8;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  let zone, emoji;
  if      (score >= 80) { zone = 'Aggressive Accum'; emoji = '🐋'; }
  else if (score >= 60) { zone = 'Smart Money Buy';  emoji = '💚'; }
  else if (score >= 40) { zone = 'Neutral';           emoji = '⚪'; }
  else if (score >= 20) { zone = 'Distribution';      emoji = '🟠'; }
  else                  { zone = 'Heavy Dist';         emoji = '🔴'; }
  return { score, zone, emoji };
}

export function calcCapBuy(d) {
  let capScore = 0;
  const r15  = d.r15 || 50, r1h = d.r1h || 50, fr = d.fr || 0;
  if (r15 < 15) capScore += 2; else if (r15 < 25) capScore += 1;
  if (r1h < 25) capScore += 2; else if (r1h < 35) capScore += 1;
  if (fr < -0.02) capScore += 2; else if (fr < -0.01) capScore += 1;
  if ((d.shock || 1) > 2.5 && d.cvdTrend !== 'up') capScore += 1;
  if (d.oiDiv === 'OI DROP') capScore += 1;
  if (d.cvdTrend === 'up')   capScore += 2;
  if ((d.chg || 0) < -7)    capScore += 1;
  return { isCapBuy: capScore >= 3 && (d.conv || 0) < -1, capScore };
}

export function calcFlow(d, whaleScore) {
  const fr    = d.fr    || 0;
  const shock = d.shock || 1;
  const oiDiv = d.oiDiv || 'NEUTRAL';
  const cvdUp = d.cvdTrend === 'up';
  const earlyEntry = (oiDiv === 'CONFIRM' || oiDiv === 'DIP BUY') && cvdUp && fr <= 0.01 && shock >= 1.3;
  if (earlyEntry && whaleScore >= 65) return 'Whales Buying';
  if (shock >= 2.0 && fr >= 0.03)     return 'Retail FOMO';
  if (whaleScore <= 35)               return 'Institutional↓';
  if (whaleScore >= 55 && earlyEntry) return 'Smart Accum';
  return 'Mixed Flow';
}

export function calcGrade(bullConf, whaleScore, btcMult = 1, buyIntelPenalty = 0) {
  const stabilityProxy = Math.round(bullConf * 9 + 10);
  let gradeScore = bullConf * 10 + (whaleScore - 50) * 0.3 + (stabilityProxy - 50) * 0.2;
  // ── Market-wide BTC gate ──────────────────────────────────────────────
  // Reuses the same continuous curve already tuned for position sizing
  // (market-guard.js checkBtcGuard / GUARD_BTC_FULL_PCT-FLOOR_PCT-FLOOR_MULT)
  // instead of a separate threshold. A falling BTC drags every crypto
  // symbol's grade/win% down proportionally, not just position size — a
  // technically-strong altcoin signal has repeatedly gotten dragged down
  // anyway once BTC itself started sliding. btcMult stays 1 (no change)
  // when BTC is flat/up, or when the caller (market-fetcher.js) has
  // determined the symbol shows genuine 4h+ structural divergence from
  // BTC rather than short-term (15-30m) noise that typically converges
  // back to BTC's direction anyway.
  gradeScore *= btcMult;
  // ── Buy Intelligence penalty (buy-intelligence.js) ──────────────────
  // bullConf's own rsiNotOb check is a single lightly-weighted point out
  // of 10 and has no candle-chasing signal at all — so a symbol flagged
  // as "3 straight green candles, already extended" could still carry a
  // clean B/A grade and pass EXEC_MIN_GRADE with no visibility into the
  // exact thing buy-intelligence was built to catch. This applies the
  // same penalty already subtracted from conv here too, so Grade/win%
  // (and therefore EXEC_MIN_GRADE-based execution filtering) actually
  // reflects a chasing/extended entry instead of being blind to it.
  gradeScore -= buyIntelPenalty * 8;
  let grade;
  if      (gradeScore >= 85) grade = 'A+';
  else if (gradeScore >= 70) grade = 'A';
  else if (gradeScore >= 50) grade = 'B';
  else if (gradeScore >= 30) grade = 'C';
  else                       grade = 'D';
  const successProb = Math.max(20, Math.min(92, Math.round(
    (bullConf * 6 + (whaleScore - 50) * 0.25 + (stabilityProxy - 50) * 0.1 + 30) * btcMult - buyIntelPenalty * 5
  )));
  return { grade, successProb, stabilityProxy };
}

export function calcSetupArchetype(d, whaleScore) {
  const shock = d.shock || 1, fr = d.fr || 0, chg = d.chg || 0;
  const cvdUp = d.cvdTrend === 'up', oiDiv = d.oiDiv || 'NEUTRAL';
  const earlyEntry = (oiDiv === 'CONFIRM' || oiDiv === 'DIP BUY') && cvdUp && fr <= 0.01 && shock >= 1.3;
  if (whaleScore >= 75 && earlyEntry)       return 'Whale Accumulation';
  if (shock >= 2.0 && d.emaTrend === 'ABOVE') return 'Momentum Breakout';
  if (d.obi > 0 && fr <= -0.01)             return 'Short Squeeze';
  if (chg < -1 && cvdUp && fr < 0)          return 'Mean Reversion';
  return 'Developing';
}

export function calcBullConf(d, whaleScore) {
  const r1h = d.r1h || 50;
  const checks = {
    dailyBiasBull:  (d.biasDay || '').includes('BULL'),
    bias4hBull:     (d.bias4h  || '').includes('BULL'),
    aboveEma:       d.emaTrend === 'ABOVE',
    oiRising:       d.oiDiv === 'CONFIRM' || d.oiDiv === 'DIP BUY',
    cvdRising:      d.cvdTrend === 'up',
    volExpansion:   (d.shock || 1) >= 1.3,
    fundingHealthy: (d.fr || 0) <= 0.01,
    obiBidHeavy:    (d.obi || 0) > 10,
    rsiNotOb:       (d.r15 || 50) < 70 && r1h < 68,
    whaleScore60:   (whaleScore ?? 0) >= 60,
  };
  return { count: Object.values(checks).filter(Boolean).length, checks };
}

// ════════════════════════════════════════════════════════
// CRYPTO SCORER  (Binance)
// ════════════════════════════════════════════════════════
// ── XMR price/OHLCV: Kraken, unconditionally — NOT a Binance-failure fallback ──
// Binance delisted all XMR pairs globally on 2024-02-20. Its ticker endpoint
// still resolves for "XMRUSDT" and returns a 200 with no error code — it just
// silently serves the last-traded price from before delisting, forever. That
// means the existing `if (!t || t.code) return null` failure check NEVER
// catches this: no error is ever thrown, so market-data.json has been frozen
// at a ~2024-era price (observed: $118.70) while XMR's real price is ~$400+.
// Unlike the funding-rate fix above, this can't be "try Binance, fall back on
// failure" — Binance isn't failing, it's silently wrong, which is worse.
// So XMR routes to Kraken unconditionally (same source already used for XMR
// on the GUI), never touching Binance for this one pair at all.
//
// Response shapes below are normalized to match exactly what scoreSymbol
// already reads from Binance responses (t.lastPrice, t.priceChangePercent;
// candle[1]=open, candle[4]=close, candle[5]=volume; depth.bids/asks as
// [price, qty, ...] pairs) — so no other code in scoreSymbol needed to change.
const KRAKEN_SPOT_DIRECT = 'https://api.kraken.com';
const KRAKEN_INTERVAL_MIN = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

async function fetchKrakenTicker(krakenPair) {
  const d = await fetchJSON(`${KRAKEN_SPOT_DIRECT}/0/public/Ticker?pair=${krakenPair}`);
  if (d?.error?.length) throw new Error(`Kraken ticker: ${d.error.join(', ')}`);
  const row = Object.values(d?.result || {})[0]; // key is Kraken's canonical name (e.g. XXMRZUSD), not krakenPair — grab by position instead
  if (!row) throw new Error(`Kraken: no ticker result for ${krakenPair}`);
  const lastPrice = parseFloat(row.c?.[0]);
  const openPrice  = parseFloat(row.o);
  const priceChangePercent = openPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0;
  return { lastPrice: String(lastPrice), priceChangePercent: String(priceChangePercent) };
}

async function fetchKrakenOHLC(krakenPair, interval, limit) {
  const mins = KRAKEN_INTERVAL_MIN[interval];
  const d = await fetchJSON(`${KRAKEN_SPOT_DIRECT}/0/public/OHLC?pair=${krakenPair}&interval=${mins}`);
  if (d?.error?.length) throw new Error(`Kraken OHLC(${interval}): ${d.error.join(', ')}`);
  const rows = Object.entries(d?.result || {}).find(([k]) => k !== 'last')?.[1];
  if (!rows) throw new Error(`Kraken: no OHLC result for ${krakenPair} @ ${interval}`);
  // Kraken candle: [time, open, high, low, close, vwap, volume, count]
  // Normalized to: [time, open, high, low, close, volume] — the only
  // indices (1=open, 4=close, 5=volume) anything downstream reads.
  // time is converted seconds -> milliseconds here (Kraken returns Unix
  // SECONDS; Binance returns milliseconds, and every consumer — most
  // importantly calcSupertrend's closed-candle filter and event-ID
  // timestamp — assumes milliseconds). Left unconverted, a real 2026
  // timestamp like 1787501852 (seconds) gets read as milliseconds, which
  // is only ~20 days after the Unix epoch — this is exactly why XMR/ST5
  // event IDs were coming out as "...19700121T...": the epoch-seconds
  // value was being interpreted as epoch-milliseconds.
  return rows.slice(-limit).map(c => [c[0] * 1000, c[1], c[2], c[3], c[4], c[6]]);
}

async function fetchKrakenDepth(krakenPair, count) {
  const d = await fetchJSON(`${KRAKEN_SPOT_DIRECT}/0/public/Depth?pair=${krakenPair}&count=${count}`);
  if (d?.error?.length) throw new Error(`Kraken depth: ${d.error.join(', ')}`);
  const row = Object.values(d?.result || {})[0];
  if (!row) throw new Error(`Kraken: no depth result for ${krakenPair}`);
  return { bids: row.bids || [], asks: row.asks || [] }; // already [price, qty, timestamp] — same shape calcOBI expects
}

export async function scoreSymbol(pair, prevFr = null, btcTriggerOk = null) {
  try {
    // XMR only — see fetchKrakenTicker/OHLC/Depth comment block above for why
    // this is unconditional routing to Kraken, not a try-Binance-first fallback.
    const useKraken = pair === 'XMRUSDT';
    const krakenPair = 'XMRUSD';

    const [ticker, k5m, k15m, k1h, k4h, kDay, depth, fundingResult] = await Promise.allSettled([
      useKraken ? fetchKrakenTicker(krakenPair)                    : fetchBinance(`/api/v3/ticker/24hr?symbol=${pair}`),
      // 5m candles — short-timeframe trigger confirmation (calcSpikeTrigger
      // in buy-intelligence.js) AND the 5m Supertrend/ST5 P0 calc below.
      // limit=200 (not 60) — Wilder/RMA-smoothed ATR technically never
      // fully "forgets" its seed value, it only decays it by a factor of
      // (period-1)/period each bar. At period=10 that's roughly 0.5%
      // residual seed influence still baked into the ATR after only 60
      // bars — usually invisible, but enough to shift a bar's final
      // upper/lower band by a hair, which is exactly enough to flip a
      // genuinely-borderline crossUp determination one way when a
      // longer-history calculation (e.g. TradingView's own Supertrend,
      // which warms up over hundreds of bars) lands the other way. 200
      // bars decays that residual to effectively 0% (<0.01%), which is
      // what actually fixes "alert fired but the chart's own redline
      // wasn't crossed" — not a formula bug, a warm-up-length bug.
      useKraken ? fetchKrakenOHLC(krakenPair, '5m', 200)           : fetchBinance(`/api/v3/klines?symbol=${pair}&interval=5m&limit=200`),
      // Same reasoning, 15m timeframe — see the 5m comment above.
      useKraken ? fetchKrakenOHLC(krakenPair, '15m', 200)          : fetchBinance(`/api/v3/klines?symbol=${pair}&interval=15m&limit=200`),
      useKraken ? fetchKrakenOHLC(krakenPair, '1h', 30)            : fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1h&limit=30`),
      useKraken ? fetchKrakenOHLC(krakenPair, '4h', 50)            : fetchBinance(`/api/v3/klines?symbol=${pair}&interval=4h&limit=50`),
      useKraken ? fetchKrakenOHLC(krakenPair, '1d', 14)            : fetchBinance(`/api/v3/klines?symbol=${pair}&interval=1d&limit=14`),
      useKraken ? fetchKrakenDepth(krakenPair, 20)                 : fetchBinance(`/api/v3/depth?symbol=${pair}&limit=20`),
      fetchFundingRate(pair), // Bybit → OKX → proxy-wrapped Bybit → Kraken — fapi.binance.com is geo-blocked on GH runners, see note above
    ]);

    const val = r => r.status === 'fulfilled' ? r.value : null;
    const t = val(ticker);
    if (!t || t.code) {
      console.log(`  ⚠  ${pair} ticker failed: ${t?.msg || ticker.reason?.message}`);
      return null;
    }

    const k5 = val(k5m), k15 = val(k15m), k1 = val(k1h), k4 = val(k4h), kD = val(kDay);
    const dep = val(depth);

    const price = parseFloat(t.lastPrice);
    const chg   = parseFloat(t.priceChangePercent);
    const vols  = (k15 || []).slice(-5).map(c => parseFloat(c[5]));
    const avgVol = vols.slice(0, 4).reduce((a, b) => a + b, 0) / 4 || 1;
    const shock  = vols[4] ? vols[4] / avgVol : 1;

    const r15 = calcRSI((k15 || []).map(c => parseFloat(c[4])));
    const r1h = calcRSI((k1  || []).map(c => parseFloat(c[4])));
    const r4h = calcRSI((k4  || []).map(c => parseFloat(c[4])));

    const k4closes = (k4 || []).map(c => parseFloat(c[4]));
    const ema20    = calcEMA(k4closes, 20);
    const emaTrend = ema20 ? (price > ema20 ? 'ABOVE' : 'BELOW') : '—';

    // 4h return — the most recent 4h candle's own open→close % change (NOT
    // r4h, which is a 4h-timeframe RSI reading, not a return). Needed for
    // Relative Strength vs BTC (Phase 2, BTC Market Regime Filter): comparing
    // a symbol's own 4h momentum against BTC's over the same window. No new
    // fetch — k4closes is already pulled above for the EMA20/bias4h calc.
    const chg4h = k4closes.length >= 2
      ? parseFloat((((k4closes[k4closes.length - 1] - k4closes[k4closes.length - 2]) / k4closes[k4closes.length - 2]) * 100).toFixed(3))
      : null;

    const bias4h   = calc4hBias(k4);
    const biasDay  = calcDailyBias(kD);
    const cvdCalc  = calcCVD(k15);
    const cvdTrend = cvdCalc.trend;      // unchanged string, existing consumers (bullConf.cvdRising etc.) untouched
    const obi      = calcOBI(dep);
    // fapi.binance.com (Binance's own funding-rate endpoint) is confirmed
    // geo-blocked (451) on GitHub runners as of 2026-07-23, with no public
    // spot-style mirror equivalent — so funding rate is sourced from Bybit
    // instead (fetchBybitFundingRate above), which isn't subject to this
    // block and returns the same rate (funding rates are near-identical
    // across major exchanges due to arbitrage). If Bybit itself is ever
    // unreachable too, carry forward the last known-good fr for this
    // symbol — still stale, but stale-and-labeled beats a false "0.000%
    // neutral" every time, which corrupts oiDiv/DIP-BUY/CONFIRM
    // classification below and (downstream) Profit Intelligence's
    // oiMomentum in market-intelligence.js.
    let fr;
    if (fundingResult.status === 'fulfilled' && fundingResult.value != null && !isNaN(fundingResult.value)) {
      fr = fundingResult.value;
    } else if (prevFr !== null && prevFr !== undefined) {
      fr = prevFr;
      console.log(`  ⚠  ${pair} — funding-rate fetch failed (${fundingResult.reason?.message || 'unknown error'}), carrying forward last known fr: ${fr.toFixed(3)}%`);
    } else {
      fr = 0;
      console.log(`  ⚠  ${pair} — funding-rate fetch failed (${fundingResult.reason?.message || 'unknown error'}), no prior value to carry forward, defaulting to 0`);
    }

    let oiDiv = 'NEUTRAL';
    if (fr <= -0.01 && chg > 0)    oiDiv = 'DIP BUY';
    else if (fr <= 0 && chg > 0.5)  oiDiv = 'CONFIRM';
    else if (fr > 0.05 && chg < 0)  oiDiv = 'OI DROP';

    const d = { p: price, chg, chg4h, shock, r15, r1h, r4h, emaTrend, bias4h, biasDay, cvdTrend, cvdStrength: cvdCalc.strength, obi, fr, oiDiv };
    d.conv = calcConviction(d);

    // ── 15m Supertrend Priority Execution (dev-team note) — entry-timing
    // signal, independent of conv/calcConviction above. market-fetcher.js
    // reads d.supertrend15m to detect a fresh closed-candle RED→GREEN
    // cross and persist a Priority-1 (P1) event; leaderboard-decider.js/
    // mexc-trader.js consume it. period/multiplier configurable per the
    // note's "make them environment-configurable and backtestable".
    d.supertrend15m = calcSupertrend(
      k15,
      parseInt(process.env.ST15_PERIOD || '10', 10),
      parseFloat(process.env.ST15_MULTIPLIER || '3'),
      ST15_INTERVAL_MS
    );

    // ── Diagnostic logging — same rationale as the ST5 block below.
    if (!d.supertrend15m) {
      if (k15m.status === 'rejected') {
        console.log(`  ⚠  ${pair} ST15 null — k15m fetch REJECTED: ${k15m.reason?.message || k15m.reason}`);
      } else if (!k15 || !k15.length) {
        console.log(`  ⚠  ${pair} ST15 null — k15 fetch returned no candles`);
      } else {
        const st15Period = parseInt(process.env.ST15_PERIOD || '10', 10);
        const closedCount = k15.filter(c => (parseInt(c[0], 10) + ST15_INTERVAL_MS) <= Date.now()).length;
        console.log(`  ⚠  ${pair} ST15 null — k15 raw=${k15.length} closed=${closedCount} need>=${st15Period + 2}`);
      }
    }

    // ── 5m Supertrend Priority Execution (Priority-0 / P0) ──
    // Same mechanism as the 15m version above, one timeframe down — a
    // fresh 5m RED→GREEN cross is the earliest, least-lagging structural
    // signal in this pipeline and per the dev-team doc takes priority over
    // BOTH the 15m cross (P1) and the normal WATCH/EARLY BUY + BREAKOUT/
    // TRIGGERING candidate path (P2). Reuses k5 — already fetched above
    // for calcSpikeTrigger's short-timeframe trigger confirmation, no new
    // API call needed. market-fetcher.js reads d.supertrend5m to detect
    // the fresh crossUp and persist a PENDING st5Event; only a genuine
    // fresh cross creates an event (a candle that's simply still BULL from
    // last cycle has crossUp=false), so a persistent bullish ST5 state
    // does not generate repeated P0 buys.
    d.supertrend5m = calcSupertrend(
      k5,
      parseInt(process.env.ST5_PERIOD || '10', 10),
      parseFloat(process.env.ST5_MULTIPLIER || '3'),
      ST5_INTERVAL_MS
    );

    // ── Diagnostic logging — ST5 was silently returning null for every
    // symbol with no visibility into why (fetch failure vs insufficient
    // closed candles vs something else). This surfaces the actual cause
    // in the Action run log the next time it happens, instead of only
    // showing up as an empty "—" in the GUI's ST5 column.
    if (!d.supertrend5m) {
      if (k5m.status === 'rejected') {
        console.log(`  ⚠  ${pair} ST5 null — k5m fetch REJECTED: ${k5m.reason?.message || k5m.reason}`);
      } else if (!k5 || !k5.length) {
        console.log(`  ⚠  ${pair} ST5 null — k5 fetch returned no candles`);
      } else {
        const st5Period = parseInt(process.env.ST5_PERIOD || '10', 10);
        const closedCount = k5.filter(c => (parseInt(c[0], 10) + ST5_INTERVAL_MS) <= Date.now()).length;
        console.log(`  ⚠  ${pair} ST5 null — k5 raw=${k5.length} closed=${closedCount} need>=${st5Period + 2}`);
      }
    }

    const setup     = getSetupMode(d);
    const whale     = calcWhaleScore(d);
    const capBuy    = calcCapBuy({ ...d, conv: d.conv });
    const bullConf  = calcBullConf(d, whale.score);
    const flow      = calcFlow(d, whale.score);

    // ── Buy Intelligence — entry-timing + data-quality check (buy-intelligence.js) ──
    // Independent of calcConviction's own scoring above; catches
    // already-extended/already-chased entries that a broken thesis check
    // (Position Intelligence) would otherwise only catch AFTER the buy,
    // 30-90 min later at a small loss. Also catches thin-data/low-confidence
    // setups (e.g. bullConf 1/10, still BUILDING) that aren't chasing or
    // extended at all, just genuinely weak — a different failure mode the
    // chase/RSI checks alone can't see. Needs bullConf/whale, so this runs
    // after them, not before as in the original ordering. Penalty subtracts
    // from conv so it can push a marginal symbol below LB_MIN_SCORE without
    // needing a separate hard gate.
    const buyIntel = evaluateBuyReadiness({ r15, r1h, k15, bullConfCount: bullConf.count, whaleScore: whale.score, currentPrice: price });
    // Preserve raw vs. adjusted conviction (§9 of the architecture doc) —
    // rawConv is the pre-penalty score (fundamentally strong setup, poor
    // entry timing); conv/adjustedConv is what everything downstream
    // (LB_MIN_SCORE, grading, SIGNAL) actually gates on. Keeping both lets
    // the UI/debugging distinguish "weak setup" from "strong setup, bad
    // entry" instead of only ever seeing the post-penalty number.
    d.rawConv = d.conv;
    if (buyIntel.penalty > 0) d.conv -= buyIntel.penalty;
    d.adjustedConv = d.conv;
    d.buyIntelPenalty = buyIntel.penalty;
    d.buyIntel = buyIntel;

    // ── Pre-spike short-timeframe trigger (calcSpikeTrigger, buy-intelligence.js) ──
    // Setup/candidate quality is everything computed above (conv, bullConf,
    // whale, CVD, RSI, OI/funding, bias4h/biasDay). This is the separate
    // question the dev-team note calls out: has the move actually started?
    // Kept as its own object (not folded into buyIntel/conv) since it's a
    // gating status for signal-evaluator.js/leaderboard-decider.js, not a
    // conviction penalty.
    const trigger = calcSpikeTrigger({ k5, k15, currentPrice: price, cvdTrend, cvdStrength: d.cvdStrength, btcTriggerOk, st5: d.supertrend5m });
    d.trigger = trigger;

    const gradeInfo = calcGrade(bullConf.count, whale.score, 1, buyIntel.penalty);
    const archetype = calcSetupArchetype(d, whale.score);
    const finalSetup = capBuy.isCapBuy ? { label: 'CAP BUY', emoji: '💥' } : setup;

    return {
      pair, price, chg, conv: d.conv, rawConv: d.rawConv, buyIntelPenalty: d.buyIntelPenalty, setup: finalSetup,
      assetType: 'crypto', exchangePrefix: 'BINANCE',
      d,
      whale: { score: whale.score, zone: whale.zone, emoji: whale.emoji },
      capBuy: { isCapBuy: capBuy.isCapBuy, capScore: capBuy.capScore },
      bullConf: bullConf.count, bullChecks: bullConf.checks,
      flow, grade: gradeInfo.grade, successProb: gradeInfo.successProb, archetype,
      trigger,
    };
  } catch (e) {
    console.log(`  ⚠  ${pair} crypto score failed: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════
// STOCK / ETF SCORER
// Uses provider fallback chain from exchange-registry.
// Works for TSX (.TO), LSE (.L), XETRA (.DE), TSE (.T),
// HKEX (.HK), NSE (.NS), and bare US symbols.
// ════════════════════════════════════════════════════════
export async function scoreStock(sym) {
  try {
    const ex             = resolveExchange(sym);
    const exchangePrefix = Object.entries((await import('./exchange-registry.js')).EXCHANGES)
      .find(([, v]) => v === ex)?.[0] ?? 'NYSE';

    // Fetch bars via provider chain (Yahoo → Stooq)
    let bars;
    try {
      ({ bars } = await fetchStockBars(sym));
    } catch (e) {
      console.log(`  ⚠  ${sym} all providers failed: ${e.message}`);
      return null;
    }

    const n       = bars.length;
    const closes  = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);

    // ── Price / 24H% ──
    // Prefer the live batched quote (primeYahooQuotes/getLiveQuote) — real
    // pre/post-market price and Yahoo's own pre-computed change%, no manual
    // previous-close arithmetic. Falls back to the daily-bar close/close
    // calc (the original, reliable method) if the live quote wasn't primed
    // or didn't come back for this symbol.
    const liveQuote = getLiveQuote(sym);
    const price = liveQuote ? liveQuote.price : closes[n - 1];
    const chg   = liveQuote ? liveQuote.chg   : parseFloat((((closes[n-1]) - (closes[n-2] || closes[n-1])) / (closes[n-2] || closes[n-1]) * 100).toFixed(2));

    // Vol shock
    const recentVols = volumes.slice(-5);
    const avgVol4    = recentVols.slice(0, 4).reduce((a, b) => a + b, 0) / 4 || 1;
    const shock      = recentVols[4] ? recentVols[4] / avgVol4 : 1;

    // RSI proxies
    const r15 = calcRSI(closes.slice(-20), 14);
    const r1h = calcRSI(closes.slice(-30), 14);
    const r4h = calcRSI(closes, 14);

    // EMA trend
    const ema20    = calcEMA(closes, Math.min(20, n));
    const emaTrend = ema20 ? (price > ema20 ? 'ABOVE' : 'BELOW') : '—';

    // 4H bias proxy (5-day daily window)
    let bias4hScore = 0;
    const recentUp4 = closes[n-1] > closes[Math.max(0, n-5)];
    const volUp4    = recentVols[4] > avgVol4;
    const k2 = 2 / 9;
    let ema8 = closes[Math.max(0, n - 9)];
    for (let i = Math.max(0, n - 8); i < n; i++) ema8 = closes[i] * k2 + ema8 * (1 - k2);
    let cvd4hCount = 0;
    for (let i = n - 4; i < n; i++) cvd4hCount += bars[i].c >= bars[i].o ? 1 : -1;
    if (closes[n-1] > ema8)  bias4hScore += 2; else bias4hScore -= 2;
    if (recentUp4)            bias4hScore += 1; else bias4hScore -= 1;
    if (volUp4 && recentUp4)  bias4hScore += 1;
    if (cvd4hCount >= 2)      bias4hScore += 2; else if (cvd4hCount >= 1) bias4hScore += 1;
    else if (cvd4hCount <= -2) bias4hScore -= 2; else if (cvd4hCount <= -1) bias4hScore -= 1;
    if (r4h < 35) bias4hScore += 1; else if (r4h > 65) bias4hScore -= 1;

    let bias4h;
    if      (bias4hScore >= 4)  bias4h = 'BULL 4H';
    else if (bias4hScore >= 2)  bias4h = 'LEAN BULL';
    else if (bias4hScore <= -4) bias4h = 'BEAR 4H';
    else if (bias4hScore <= -2) bias4h = 'LEAN BEAR';
    else                        bias4h = 'NEUTRAL';

    // Daily bias
    let biasDayScore = 0;
    const k3 = 2 / 8;
    let ema7 = closes[Math.max(0, n - 8)];
    for (let i = Math.max(0, n - 7); i < n; i++) ema7 = closes[i] * k3 + ema7 * (1 - k3);
    const avgVolD    = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1) || 1;
    const volSurge   = volumes[n-1] > avgVolD * 1.4;
    const chg7d      = closes[n-7] > 0 ? parseFloat(((closes[n-1] - closes[n-7]) / closes[n-7] * 100).toFixed(1)) : 0;
    let cvdDailyCount = 0;
    for (let i = n - 7; i < n; i++) cvdDailyCount += bars[i].c >= bars[i].o ? 1 : -1;
    if (closes[n-1] > ema7)  biasDayScore += 2; else biasDayScore -= 2;
    if (chg7d > 5) biasDayScore += 2; else if (chg7d > 1) biasDayScore += 1;
    else if (chg7d < -5) biasDayScore -= 2; else if (chg7d < -1) biasDayScore -= 1;
    if (volSurge && chg7d > 0) biasDayScore += 1;
    if (volSurge && chg7d < 0) biasDayScore -= 1;
    if (cvdDailyCount >= 4) biasDayScore += 2; else if (cvdDailyCount >= 2) biasDayScore += 1;
    else if (cvdDailyCount <= -4) biasDayScore -= 2; else if (cvdDailyCount <= -2) biasDayScore -= 1;
    if (r4h < 35) biasDayScore += 1; else if (r4h > 65) biasDayScore -= 1;

    let biasDay;
    if      (biasDayScore >= 5)  biasDay = 'BULL DAY';
    else if (biasDayScore >= 2)  biasDay = 'LEAN BULL';
    else if (biasDayScore <= -5) biasDay = 'BEAR DAY';
    else if (biasDayScore <= -2) biasDay = 'LEAN BEAR';
    else                         biasDay = 'NEUTRAL';

    const cvdTrend  = cvd4hCount >= 0 ? 'up' : 'down';

    // OI divergence proxy
    const longHeavy = bias4hScore > 0;
    const priceUp   = chg >= 0;
    let oiDiv;
    if      ( priceUp && !longHeavy) oiDiv = 'DIP BUY';
    else if (!priceUp &&  longHeavy) oiDiv = 'DIP BUY';
    else if ( priceUp &&  longHeavy) oiDiv = 'CONFIRM';
    else                             oiDiv = 'OI DROP';

    const fr = 0, obi = 0; // not available for stocks

    const d = { p: price, chg, shock, r15, r1h, r4h, emaTrend, bias4h, biasDay, cvdTrend, obi, fr, oiDiv };
    d.conv = calcConviction(d);

    const setup     = getSetupMode(d);
    const whale     = calcWhaleScore(d);
    const bullConf  = calcBullConf(d, whale.score);
    const flow      = calcFlow(d, whale.score);

    const buyIntel = evaluateStockBuyReadiness({ r15, r1h, bars, bullConfCount: bullConf.count, whaleScore: whale.score, currentPrice: price });
    d.rawConv = d.conv;
    if (buyIntel.penalty > 0) d.conv -= buyIntel.penalty;
    d.adjustedConv = d.conv;
    d.buyIntelPenalty = buyIntel.penalty;
    d.buyIntel = buyIntel;

    const gradeInfo = calcGrade(bullConf.count, whale.score, 1, buyIntel.penalty);
    const archetype = calcSetupArchetype(d, whale.score);

    return {
      pair: sym, price, chg, conv: d.conv, rawConv: d.rawConv, buyIntelPenalty: d.buyIntelPenalty, setup,
      assetType: 'stock', exchangePrefix,
      d,
      whale: { score: whale.score, zone: whale.zone, emoji: whale.emoji },
      capBuy: { isCapBuy: false, capScore: 0 },
      bullConf: bullConf.count, bullChecks: bullConf.checks,
      flow, grade: gradeInfo.grade, successProb: gradeInfo.successProb, archetype,
    };
  } catch (e) {
    console.log(`  ⚠  ${sym} stock score failed: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════
// STANDALONE LEADERBOARD SCANNER (called from alert-runner)
// ════════════════════════════════════════════════════════
export async function runLeaderboardScanner(state) {
  let watchlist = [];
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    watchlist = Array.isArray(raw) ? raw : raw.symbols || [];
  } catch { watchlist = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT']; }

  const cryptoPairs = watchlist.filter(s => s.startsWith('BINANCE:')).map(s => s.replace('BINANCE:', ''));
  const stockSyms   = watchlist.filter(s => !s.startsWith('BINANCE:'));

  const total = cryptoPairs.length + stockSyms.length;
  if (!total) { console.log('\n📡  Leaderboard scanner — no symbols in watchlist'); return; }
  console.log(`\n📡  Leaderboard scanner — ${cryptoPairs.length} crypto + ${stockSyms.length} stock/ETF`);

  if (stockSyms.length) await initYahoo();

  const allResults = [
    ...(await Promise.all(cryptoPairs.map(scoreSymbol))),
    ...(await Promise.all(stockSyms.map(scoreStock))),
  ];

  const scored = allResults.filter(Boolean).filter(r => r.conv >= LB_MIN_SCORE);
  scored.sort((a, b) => b.conv - a.conv);

  // ── Market guard — same gate stack leaderboard-decider.js uses before it
  // will let anything buy. Previously this scanner only checked
  // conv >= LB_MIN_SCORE, so it could (and did) fire a Telegram "BUY" alert
  // for a candidate the Decider would separately block on BTC risk,
  // breadth, bull-4H persistence, or the BTC regime gate — the exact
  // failure mode called out in the dev-team architecture doc (§8): server-
  // side alerts must use the same market/symbol evaluation as the Decider,
  // not just a bare conviction threshold. Loaded once per scan, not per
  // symbol — market/positions/marketState don't change mid-cycle.
  const market      = loadMarketData();
  const positions   = loadPositions();
  const marketState = loadMarketState();
  const guard        = runAllBuyGuards(market, positions, marketState);
  if (guard.hardBlocked) {
    console.log(`  🛡  Leaderboard scanner — market guard hard-blocked this cycle (${guard.reasons.join('; ')}) — no alerts.`);
  }

  const buyAlerts = [];
  for (const r of scored) {
    const { pair, price, conv, setup } = r;
    if (setup.label === 'WATCHING' || setup.label === 'SHORT SETUP') continue;
    if (isOnCooldown(state, pair)) { console.log(`  🔕  ${pair} [${setup.label}] — cooldown`); continue; }

    // ── Shared SIGNAL evaluator — must be BUY/EARLY BUY, matching the
    // execution-intent taxonomy every other consumer of market-data.json
    // now reads (see signal-evaluator.js). Replaces the old bare
    // "conv >= LB_MIN_SCORE" as the sole bar for firing an alert.
    const { signal, entryState } = classifySignal(r);
    if (!isBuyEligible(signal)) {
      console.log(`  ⏭  ${pair} [${setup.label}] score:${conv} — SIGNAL=${signal}, not buy-eligible — skipping alert`);
      continue;
    }

    if (guard.hardBlocked) continue; // circuit breaker / BTC panic / blackout — no per-symbol exception applies here

    if (r.assetType === 'crypto') {
      if (guard.btcRegimeBlocked) {
        console.log(`  🛡  ${pair} — BTC 4H regime block active this cycle — skipping (scanner has no per-symbol Alpha Exception path)`);
        continue;
      }
      // bull4hCount is maintained by market-fetcher.js on the PERSISTED
      // market-data.json entry (this fresh scan result has no such field
      // of its own — it's a brand-new scoreSymbol() call, not the
      // accumulated multi-cycle state).
      const persistedEntry = market.symbols?.[pair];
      const persistence = checkBull4hPersistence(persistedEntry || r);
      if (!persistence.allowed) {
        console.log(`  ⏳  ${pair} — 4H bull trend only ${persistence.count} cycle(s) old — skipping, possible short-lived flip`);
        continue;
      }
      const miGate = checkMarketIntelligenceGate(marketState, { ...r, symbol: pair }, marketState.symbols?.[pair], market.global || {});
      if (!miGate.notReady && !miGate.allowed) {
        console.log(`  🧠  ${pair} — Market Intelligence gate blocked (${miGate.reasons.join('; ')}) — skipping alert`);
        continue;
      }
    }

    const levels = calcEntryLevels(price, r.d.shock);
    buyAlerts.push({ pair, conv, setup, price, levels, d: r.d, assetType: r.assetType, signal, entryState });
    markCooldown(state, pair);
    console.log(`  🟢  ${pair} [${setup.label}] score:${conv} SIGNAL=${signal} (${r.assetType})`);
  }

  if (!buyAlerts.length) { console.log('  ✓  No new buy signals'); return; }

  const utc   = new Date().toUTCString().slice(17, 22) + ' UTC';
  const lines = buyAlerts.map(a => {
    const l = a.levels;
    return [
      `${a.setup.emoji} *${a.pair.replace('USDT', '')}* — ${a.setup.label}  [${a.conv}/20]  (${a.assetType})`,
      `  SIGNAL: ${a.signal}  ENTRY_STATE: ${a.entryState}`,
      `  Entry $${l?.entry || '—'}  Stop $${l?.stop || '—'}  T1 $${l?.t1 || '—'}  T2 $${l?.t2 || '—'}`,
      `  R:R ${l?.rr || '—'}  4H: ${a.d.bias4h}  CVD: ${a.d.cvdTrend}  FR: ${a.d.fr?.toFixed(3) || '0.000'}%`,
    ].join('\n');
  });

  await sendTelegram([
    `🔔 *Alpha Terminal — Leaderboard Scanner*`,
    `_${utc} · ${buyAlerts.length} signal(s) · min score ${LB_MIN_SCORE}_`,
    '', lines.join('\n\n'), '',
    `_Headless scan — open GUI to see live leaderboard_`,
  ].join('\n'));
}

export function isCrypto(sym) { return !sym.includes('.'); }
export { loadState, saveState };
