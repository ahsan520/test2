// ══════════════════════════════════════════════════════════════════════════════
// analyst-picks-fetcher.js — structured analyst-ratings + earnings-calendar poller
// --------------------------------------------------------------------------
// v2 — replaces the original RSS-headline-text-mining approach. That approach
// re-surfaced the same handful of headlines run after run (news doesn't
// turn over every 5 min the way price data does) and only ever caught a
// rating change if a wire happened to write a headline about it that day.
// This version pulls STRUCTURED rating-change and earnings-date data
// instead, so results are query-driven, not headline-luck-driven.
//
// v4 — added a Finnhub /stock/recommendation-trend fallback (free tier —
// unlike /stock/upgrade-downgrade above) for symbols where Yahoo returned
// no specific rating action. It's a monthly buy/hold/sell consensus count,
// not a per-firm event, so it's only used to fill the gap, never to
// override an actual Yahoo upgrade/downgrade.
//
// Sources:
//   RATINGS:  Yahoo Finance quoteSummary (recommendationTrend +
//             upgradeDowngradeHistory modules) — free, no key, per-symbol,
//             universe-limited (watchlist + Nasdaq-100) always.
//             Fallback: Finnhub /stock/recommendation-trend (free tier)
//             for symbols Yahoo didn't return a specific action for —
//             surfaces consensus direction (up/down), not a firm+date.
//   EARNINGS: Finnhub.io /calendar/earnings if FINNHUB_API_KEY is set —
//             this endpoint IS free-tier, market-wide, date-ranged. Falls
//             back to whatever Yahoo's calendarEvents module found
//             per-symbol if no key is set.
//
// Cadence: runs 4x/day at fixed ET times (FETCH_WINDOWS_ET below) — this
// data doesn't change intraday every 5 min the way price data does, so
// polling it that often was the actual cause of "same info every time",
// but a single daily run also means anything issued mid-day (an upgrade at
// 11am, an earnings-date change) doesn't show up until the next morning.
// 4x/day is a middle ground: pre-market, mid-morning, midday, after-close.
//
// Output shape (scripts/analyst-picks-data.json):
//   {
//     fetchedAt, source: 'finnhub'|'yahoo',
//     items: [{
//       symbol, company,
//       signal: 'upgrade'|'downgrade'|'initiated-bullish'|'initiated-bearish'|
//               'initiated-neutral'|'reiterated'|'consensus-up'|'consensus-down'|
//               'earnings'|'both',
//       ratingFrom, ratingTo, firm, ratingDate, action ('up'|'down'|'init'|'main'|null),
//       recTrend: { period, buy, hold, sell, strongBuy, strongSell } | undefined,
//       earningsDate, daysToEarnings, score, source
//     }]
//   }
// Sorted by score descending — "recent upgrade AND earnings within 7 days"
// ranks highest, since that intersection is the actual "look at this
// before market open" signal, not either alone.
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';

const OUT_PATH       = path.join(process.cwd(), 'analyst-picks-data.json');
const WATCHLIST_PATH = path.join(process.cwd(), '..', 'watchlist.json');

// ── Yahoo Finance session (cookie + crumb) ──────────────────────────────
// quoteSummary has required a session cookie + crumb token since Yahoo
// tightened access in 2024 — a bare fetch() with only a User-Agent header
// gets rejected (401/999) and fetchYahooOne()'s catch{} swallowed that
// silently, so ratings looked "fetched" but came back empty for every
// symbol, every run. leaderboard-scanner.js already solved this same
// problem for its own Yahoo calls; mirrored here so quoteSummary carries
// the same cookie/crumb.
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let yahooCookie  = '';
let yahooCrumb   = '';
let yahooInited  = false;

async function initYahoo() {
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
      console.log('  ⚠  Yahoo crumb unexpected — ratings fetch will likely fail this run');
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

// Target times in ET, each { h, m } (24h clock) — minute-precision, not
// just hour-aligned. Matched with a tolerance window (see WINDOW_TOLERANCE_MIN)
// since this only actually runs when the native */5 cron or the Worker's
// catch-up dispatch happens to invoke `fetch` mode — it doesn't fire on
// its own, so the gate below has to catch "close enough", not exact.
const FETCH_WINDOWS_ET = [
  { h: 7,  m: 0  }, // pre-market
  { h: 11, m: 0  }, // mid-morning
  { h: 14, m: 0  }, // midday
  { h: 20, m: 0 }, // after-close-ish
];
const WINDOW_TOLERANCE_MIN    = 5; // native cron is */5, so ±5 min reliably catches one tick
const EARNINGS_LOOKAHEAD_DAYS = 7;
const MAX_ITEMS_OUT           = 60;
const MIN_HOURS_BETWEEN_RUNS  = 3; // guards against double-firing within the same target window's nearby ticks

// Watchlist + Nasdaq-100 constituents. Finnhub's upgrade-downgrade endpoint
// is queried market-wide (no symbol needed); this universe is used for the
// Yahoo backup path (per-symbol only) and to bias scoring toward names you
// actually track.
const NASDAQ_100 = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','AVGO','TSLA','COST',
  'NFLX','AMD','PEP','ADBE','CSCO','TMUS','LIN','QCOM','INTU','TXN',
  'AMGN','CMCSA','ISRG','AMAT','HON','BKNG','VRTX','PANW','ADP','SBUX',
  'GILD','MU','ADI','LRCX','MDLZ','REGN','PYPL','KLAC','SNPS','CDNS',
  'MELI','CRWD','MAR','ORLY','CSX','ASML','ABNB','FTNT','MRVL','WDAY',
  'PCAR','NXPI','ROP','MNST','PAYX','CPRT','ODFL','DXCM','AEP','ROST',
  'KDP','FANG','EXC','CTAS','CHTR','KHC','EA','VRSK','TTD','FAST',
  'CTSH','BKR','GEHC','DDOG','ANSS','ON','ZS','TEAM','CCEP','MCHP',
  'GFS','WBD','ILMN','BIIB','DLTR','MRNA','LULU','SIRI','WBA','ENPH',
];

function loadWatchlistSymbols() {
  try {
    const raw  = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.symbols || [];
    return list
      .filter(s => !s.startsWith('BINANCE:')) // crypto has no analyst ratings/earnings
      .map(s => s.includes(':') ? s.split(':')[1] : s)
      .map(s => s.split('.')[0]); // strip .TO/.L/etc — Finnhub/Yahoo want the bare US-listing symbol
  } catch { return []; }
}

function buildUniverse() {
  const seen = new Set(); const out = [];
  for (const s of [...loadWatchlistSymbols(), ...NASDAQ_100]) {
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); }
  catch { return { fetchedAt: 0, items: [] }; }
}
function saveOutput(data) { fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2)); }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

async function fetchFinnhubEarnings(apiKey, fromDate, toDate) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.log(`Finnhub earnings calendar: HTTP ${r.status}`); return []; }
    const data = await r.json();
    return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
  } catch (e) { console.log(`Finnhub earnings calendar fetch failed: ${e.message}`); return []; }
}

// /stock/recommendation-trend — aggregated monthly buy/hold/sell counts
// across all covering analysts. Unlike /stock/upgrade-downgrade (paid-plan
// only — individual firm actions), this endpoint IS free-tier. It doesn't
// give a "Firm X moved from Hold to Buy" event the way Yahoo's
// upgradeDowngradeHistory does, but it does show whether the consensus is
// drifting more bullish or bearish month over month — used here only as a
// fallback for symbols where Yahoo returned no specific rating action, so
// those rows aren't left with earnings-only info when a real signal exists.
async function fetchFinnhubRecommendationTrend(apiKey, symbol) {
  const url = `https://finnhub.io/api/v1/stock/recommendation-trend?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // API returns most-recent-period first.
    const latest = rows[0];
    const prev   = rows[1] || null;
    return { latest, prev };
  } catch { return null; }
}

// Bullishness score for a single recommendation-trend row: strongBuy/buy
// weighted above hold, sell/strongSell weighted negative. Only the sign and
// relative change between two periods matters here, not the absolute value.
function _recTrendBullScore(row) {
  if (!row) return null;
  return (row.strongBuy || 0) * 2 + (row.buy || 0) - (row.sell || 0) - (row.strongSell || 0) * 2;
}

async function fetchYahooOne(symbol) {
  const modules      = 'recommendationTrend,upgradeDowngradeHistory,calendarEvents,price';
  const crumbSuffix  = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${crumbSuffix}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: yahooHeaders() });
    if (!r.ok) { console.log(`  Yahoo ${symbol}: HTTP ${r.status}`); return null; }
    const data = await r.json();
    const res = data?.quoteSummary?.result?.[0];
    if (!res) return null;

    const company = res.price?.longName || res.price?.shortName || symbol;
    const hist = res.upgradeDowngradeHistory?.history || [];
    const recent = hist.filter(h => h.epochGradeDate).sort((a, b) => b.epochGradeDate - a.epochGradeDate)[0];
    const earningsTs = res.calendarEvents?.earnings?.earningsDate?.[0]?.raw;

    return {
      symbol, company,
      ratingFrom: recent?.fromGrade || null,
      ratingTo:   recent?.toGrade   || null,
      firm:       recent?.firm      || null,
      ratingDate: recent?.epochGradeDate ? recent.epochGradeDate * 1000 : null,
      earningsDate: earningsTs ? earningsTs * 1000 : null,
      action: recent?.action || null,
      source: 'yahoo',
    };
  } catch { return null; }
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

function _ratingSentiment(grade) {
  if (!grade) return null;
  const g = grade.toLowerCase();
  if (/(strong buy|^buy$|outperform|overweight|positive|accumulate)/.test(g)) return 'positive';
  if (/(strong sell|^sell$|underperform|underweight|negative|reduce)/.test(g)) return 'negative';
  return 'neutral'; // hold, neutral, equal-weight, market perform, sector perform, peer perform
}

function scoreItem(it) {
  let score = 0;
  const hasEarnings = it.daysToEarnings != null && it.daysToEarnings >= 0 && it.daysToEarnings <= EARNINGS_LOOKAHEAD_DAYS;
  const isRealUpgrade = it.signal === 'upgrade' || it.signal === 'both';
  if (isRealUpgrade)                score += 40; // actual rating raised — the only case that's a genuine directional change
  if (it.signal === 'downgrade')    score += 15; // genuine directional change the other way — still worth flagging
  if (it.signal === 'initiated-bullish')  score += 18; // new coverage, positive — new attention, not a change
  if (it.signal === 'initiated-bearish')  score += 10;
  if (it.signal === 'consensus-up')   score += 20;
  if (it.signal === 'consensus-down') score += 8;
  if (it.signal === 'reiterated')     score += 2;  // no new info — barely nudges score, mostly for tie-breaking by recency
  if (hasEarnings) score += 30;
  if (isRealUpgrade && hasEarnings) score += 30;
  if (it.ratingDate) score += Math.max(0, 10 - daysBetween(it.ratingDate, Date.now()));
  return score;
}

// Returns the nearest target window's distance in minutes, or null if none
// are within tolerance. Minutes-of-day comparison, ET wall-clock.
function _nearestWindowDistanceMin(nowMinutesOfDay) {
  let best = null;
  for (const w of FETCH_WINDOWS_ET) {
    const targetMin = w.h * 60 + w.m;
    const dist = Math.abs(nowMinutesOfDay - targetMin);
    if (best === null || dist < best) best = dist;
  }
  return best;
}

async function main() {
  const now = new Date();
  const etParts = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
  const etHour = Number(etParts[0]);
  const etMin  = Number(etParts[1]);
  const nowMinutesOfDay = etHour * 60 + etMin;

  const dist = _nearestWindowDistanceMin(nowMinutesOfDay);
  const windowsStr = FETCH_WINDOWS_ET.map(w => `${String(w.h).padStart(2,'0')}:${String(w.m).padStart(2,'0')}`).join(',');
  if (dist === null || dist > WINDOW_TOLERANCE_MIN) {
    console.log(`ET time ${String(etHour).padStart(2,'0')}:${String(etMin).padStart(2,'0')} not within ±${WINDOW_TOLERANCE_MIN}min of any target window [${windowsStr}] — skipping`);
    return;
  }

  const existing = loadExisting();
  if (existing.fetchedAt && (Date.now() - existing.fetchedAt) < MIN_HOURS_BETWEEN_RUNS * 3600000) {
    console.log(`Last fetch was < ${MIN_HOURS_BETWEEN_RUNS}h ago — skipping (avoids double-fire within the same target hour)`);
    return;
  }

  const apiKey    = process.env.FINNHUB_API_KEY || '';
  const universe  = buildUniverse();
  const bySymbol  = new Map();

  const toDate   = new Date().toISOString().slice(0, 10);
  const earnTo   = new Date(Date.now() + EARNINGS_LOOKAHEAD_DAYS * 86400000).toISOString().slice(0, 10);

  // ── Ratings: always via Yahoo per-symbol backup ──
  // Finnhub's /stock/upgrade-downgrade is a PAID-PLAN-ONLY endpoint (401/403
  // on the free tier — confirmed against a live free-tier key returning
  // HTTP 403 while /calendar/earnings on the same key succeeded). There is
  // no free market-wide ratings source, so this is universe-limited
  // (watchlist + Nasdaq-100) regardless of whether FINNHUB_API_KEY is set.
  console.log('Fetching ratings via Yahoo per-symbol backup (Finnhub upgrade-downgrade requires a paid plan — universe-limited either way)');
  await initYahoo();
  const yahooResults = await mapLimit(universe, 6, fetchYahooOne);
  let yahooHits = 0;
  for (const r of yahooResults) { if (r) { bySymbol.set(r.symbol, r); yahooHits++; } }
  console.log(`Yahoo ratings: ${yahooHits}/${universe.length} symbols returned data`);

  // ── Earnings: Finnhub market-wide if key present (this endpoint IS free),
  // else fall back to whatever Yahoo already found per-symbol above. ──
  if (apiKey) {
    const earnings = await fetchFinnhubEarnings(apiKey, toDate, earnTo);
    for (const e of earnings) {
      const sym = e.symbol; if (!sym) continue;
      const prev = bySymbol.get(sym) || { symbol: sym, company: sym, source: 'finnhub' };
      const edate = e.date ? new Date(e.date + 'T00:00:00Z').getTime() : null;
      if (edate && (!prev.earningsDate || edate < prev.earningsDate)) prev.earningsDate = edate;
      bySymbol.set(sym, prev);
    }
    console.log(`Finnhub: ${earnings.length} earnings dates in window (market-wide)`);

    // ── Consensus fallback: recommendation-trend (free tier) for any symbol
    // that still has no Yahoo rating action. Only queried for that subset —
    // no point spending calls re-confirming what Yahoo already gave us. ──
    const needsConsensus = universe.filter(sym => {
      const it = bySymbol.get(sym);
      return it && !it.ratingTo && !it.action;
    });
    if (needsConsensus.length) {
      const trendResults = await mapLimit(needsConsensus, 6, sym => fetchFinnhubRecommendationTrend(apiKey, sym));
      let consensusHits = 0;
      trendResults.forEach((res, idx) => {
        if (!res) return;
        const sym = needsConsensus[idx];
        const it  = bySymbol.get(sym);
        if (!it) return;
        const bullNow  = _recTrendBullScore(res.latest);
        const bullPrev = _recTrendBullScore(res.prev);
        it.recTrend = {
          period: res.latest.period, buy: res.latest.buy, hold: res.latest.hold,
          sell: res.latest.sell, strongBuy: res.latest.strongBuy, strongSell: res.latest.strongSell,
        };
        if (bullPrev != null && bullNow !== bullPrev) {
          it.consensusDirection = bullNow > bullPrev ? 'up' : 'down';
          consensusHits++;
        }
        bySymbol.set(sym, it);
      });
      console.log(`Finnhub recommendation-trend: ${consensusHits}/${needsConsensus.length} symbols showed a consensus shift (${needsConsensus.length} queried, missing a Yahoo rating action)`);
    }
  } else {
    console.log('FINNHUB_API_KEY not set — earnings dates limited to whatever Yahoo returned per-symbol above, no consensus fallback');
  }

  const items = [...bySymbol.values()]
    .filter(it => it.ratingDate || it.earningsDate || it.consensusDirection)
    .map(it => {
      const daysToEarnings = it.earningsDate != null ? daysBetween(Date.now(), it.earningsDate) : null;
      const hasEarnSoon    = daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= EARNINGS_LOOKAHEAD_DAYS;

      // Signal is keyed off the actual Yahoo `action` field, not just
      // whether the current rating happens to be positive — a reiterated
      // Buy (action:'main') and a fresh upgrade to Buy (action:'up') both
      // end up with ratingTo:'Buy', but only one of them is new information.
      // See _ratingSentiment for the up/down/init/main → signal mapping.
      const sentiment = _ratingSentiment(it.ratingTo);
      let signal;
      if (it.action === 'up')        signal = hasEarnSoon ? 'both' : 'upgrade';
      else if (it.action === 'down') signal = 'downgrade';
      else if (it.action === 'init') signal = sentiment === 'negative' ? 'initiated-bearish'
                                             : sentiment === 'positive' ? 'initiated-bullish'
                                             : 'initiated-neutral';
      else if (it.action === 'main') signal = 'reiterated';
      else if (it.consensusDirection === 'up')   signal = 'consensus-up';
      else if (it.consensusDirection === 'down') signal = 'consensus-down';
      else signal = 'earnings';

      const full = { ...it, daysToEarnings, signal };
      full.score = scoreItem(full);
      return full;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS_OUT);

  saveOutput({ fetchedAt: Date.now(), source: apiKey ? 'yahoo+finnhub' : 'yahoo', items });
  console.log(`Analyst picks: ${items.length} items saved (source: ${apiKey ? 'yahoo+finnhub' : 'yahoo'})`);
}

main().catch(e => { console.error('analyst-picks-fetcher fatal error:', e); process.exit(0); });
