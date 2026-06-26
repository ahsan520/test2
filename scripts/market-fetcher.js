// ══════════════════════════════════════════════════════════════════════════════
// market-fetcher.js — Job A (runs every 5 min)
// v10.8: added stock/ETF support via Yahoo Finance (scoreStock).
//        Watchlist is split into BINANCE: (crypto) and everything else
//        (stocks/ETFs). Both are scored and merged into market-data.json
//        using the same entry shape so leaderboard-decider.js treats them
//        identically.
//
// WHY: leaderboard setups are gated by shock + OBI — both can spike and fade
// within a 15-min window. Job A polls every 5 min and tracks the PEAK
// shock/obi seen since Job B last consumed the file. Job B reads peaks then
// resets them. This means spikes are caught even if they fade between polls.
//
// v10.3: Audit rotation changed to time-based (1 hour).
// v10.6: stores full enrichment — bullConf, whale, capBuy, flow, grade, archetype, r1h
// v10.8: stocks/ETFs now scored via Yahoo Finance and included in market-data.json
// ══════════════════════════════════════════════════════════════════════════════

import fs   from 'fs';
import path from 'path';
import { scoreSymbol, scoreStock, initYahoo, isCrypto } from './leaderboard-scanner.js';

// Use process.cwd() for reliable path resolution in GitHub Actions
const WATCHLIST_PATH    = path.join(process.cwd(), '..', 'watchlist.json');
const MARKET_DATA_PATH  = path.join(process.cwd(), 'market-data.json');
const AUDIT_PATH        = path.join(process.cwd(), 'audit.json');

const STALE_MINUTES = 30;

function loadWatchlist() {
  try {
    const raw  = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.symbols || [];
    const crypto = list
      .filter(s => s.startsWith('BINANCE:'))
      .map(s => s.replace('BINANCE:', ''));
    const stocks = list.filter(s => !s.startsWith('BINANCE:'));
    return { crypto, stocks };
  } catch {
    return { crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], stocks: [] };
  }
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(MARKET_DATA_PATH, 'utf8')); }
  catch { return { fetchedAt: 0, symbols: {} }; }
}

function saveMarketData(data) {
  fs.writeFileSync(MARKET_DATA_PATH, JSON.stringify(data, null, 2));
}

function logAudit(action, details = {}) {
  const audit = { timestamp: new Date().toISOString(), job: 'market-fetcher', action, ...details };
  let logs = [];
  try {
    logs = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    if (!Array.isArray(logs)) logs = [];
  } catch {}
  logs.push(audit);
  const cutoff = Date.now() - 60 * 60 * 1000;
  logs = logs.filter(e => new Date(e.timestamp).getTime() >= cutoff);
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(logs, null, 2));
}

// ── Build a symbols entry from a scoreSymbol / scoreStock result ──
// Handles peak tracking: max absolute shock/obi seen since Job B last reset.
function buildEntry(r, prev, now) {
  const shock = r.d.shock || 1;
  const obi   = r.d.obi   || 0;

  const peakShock = Math.max(shock, prev?.peakShock ?? shock);
  const peakObi   = Math.abs(obi) > Math.abs(prev?.peakObi ?? 0) ? obi : (prev?.peakObi ?? obi);

  return {
    pair:        r.pair,
    price:       r.price,
    chg:         r.chg,
    conv:        r.conv,
    setup:       r.setup,
    assetType:   r.assetType,           // 'crypto' | 'stock'
    exchangePrefix: r.exchangePrefix,   // 'BINANCE' | 'TSX' | 'NYSE'
    d:           r.d,
    // enriched fields
    bullConf:    r.bullConf,
    bullChecks:  r.bullChecks,
    whale:       r.whale,
    capBuy:      r.capBuy,
    flow:        r.flow,
    grade:       r.grade,
    successProb: r.successProb,
    archetype:   r.archetype,
    // peak tracking
    peakShock,
    peakObi,
    peakSince:   prev?.peakSince ?? now,
    updatedAt:   now,
  };
}

async function main() {
  const { crypto: cryptoPairs, stocks: stockSyms } = loadWatchlist();
  const totalSymbols = cryptoPairs.length + stockSyms.length;

  if (!totalSymbols) {
    console.log('[market-fetcher] No symbols in watchlist — nothing to fetch.');
    logAudit('no_symbols', { count: 0 });
    return;
  }

  console.log(`[market-fetcher] Fetching ${cryptoPairs.length} crypto + ${stockSyms.length} stock/ETF symbol(s)...`);

  const existing = loadExisting();
  const now = Date.now();

  // Init Yahoo session once upfront if we have stock symbols
  if (stockSyms.length) {
    await initYahoo();
  }

  // Fetch all in parallel (crypto and stocks run concurrently)
  const [cryptoResults, stockResults] = await Promise.all([
    Promise.all(cryptoPairs.map(scoreSymbol)),
    Promise.all(stockSyms.map(scoreStock)),
  ]);

  const symbols = {};
  let okCount = 0;
  const fetchResults = [];

  // ── Process crypto results ──
  for (let i = 0; i < cryptoPairs.length; i++) {
    const pair = cryptoPairs[i];
    const r    = cryptoResults[i];
    const key  = pair; // market-data keyed by raw pair (BTCUSDT, ETHY.TO, etc.)
    const prev = existing.symbols?.[key];

    if (!r) {
      if (prev) symbols[key] = prev;
      console.log(`  ⚠  ${pair} — crypto fetch failed, carrying forward`);
      fetchResults.push({ pair, status: 'failed_carried_forward', assetType: 'crypto' });
      continue;
    }
    okCount++;
    symbols[key] = buildEntry(r, prev, now);
    fetchResults.push({ pair, status: 'success', conv: r.conv, setup: r.setup.label, assetType: 'crypto' });
  }

  // ── Process stock/ETF results ──
  for (let i = 0; i < stockSyms.length; i++) {
    const sym  = stockSyms[i];
    const r    = stockResults[i];
    const key  = sym;
    const prev = existing.symbols?.[key];

    if (!r) {
      if (prev) symbols[key] = prev;
      console.log(`  ⚠  ${sym} — stock fetch failed, carrying forward`);
      fetchResults.push({ pair: sym, status: 'failed_carried_forward', assetType: 'stock' });
      continue;
    }
    okCount++;
    symbols[key] = buildEntry(r, prev, now);
    fetchResults.push({ pair: sym, status: 'success', conv: r.conv, setup: r.setup.label, assetType: 'stock' });
  }

  const out = { fetchedAt: now, staleAfterMinutes: STALE_MINUTES, symbols };
  saveMarketData(out);

  logAudit('fetch_complete', {
    totalPairs:   totalSymbols,
    successCount: okCount,
    failureCount: totalSymbols - okCount,
    cryptoCount:  cryptoPairs.length,
    stockCount:   stockSyms.length,
    results:      fetchResults,
  });

  console.log(`[market-fetcher] Wrote market-data.json — ${okCount}/${totalSymbols} symbol(s) updated (${cryptoPairs.length} crypto, ${stockSyms.length} stocks).`);
}

main().catch(err => {
  console.error('[market-fetcher] Fatal:', err);
  logAudit('fatal_error', { error: err.message });
  process.exit(1);
});
