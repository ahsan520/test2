// ══════════════════════════════════════════════
// top-picks.js — Analyst ratings + earnings-calendar panel
// ------------------------------------------------
// DISPLAY-ONLY, same contract as general-news.js: never touches positions,
// never trades, never fires Telegram alerts.
//
// Data source: scripts/analyst-picks-data.json, written server-side ONCE
// PER DAY (pre-market) by scripts/analyst-picks-fetcher.js. Structured
// rating-change data (Yahoo per-symbol, always) + earnings-date data
// FINNHUB_API_KEY is set, else Yahoo per-symbol backup limited to the
// watchlist + Nasdaq-100 universe) — not headline text-mining, so it
// doesn't just re-show the same news over and over.
//
// Sorted server-side by score (recent-upgrade + earnings-within-7-days
// scores highest). This is a screening list to manually review, not a buy
// signal — always check the actual rating/date before acting on it.
// ══════════════════════════════════════════════

const TOP_PICKS_DATA_REPO   = () => (typeof _deriveRepo === 'function' ? _deriveRepo() : (window.__GH_REPO || ''));
const TOP_PICKS_DATA_BRANCH = 'main';
const TOP_PICKS_DATA_PATH   = 'scripts/analyst-picks-data.json';

async function fetchTopPicks(manual) {
  const repo = TOP_PICKS_DATA_REPO();
  if (!repo) { renderTopPicks(); return; }

  const btn = document.getElementById('top-picks-refresh-btn');
  if (manual && btn) { btn.disabled = true; btn.textContent = '⟳ …'; }

  // cache-buster (?t=) already forces a fresh pull past any CDN/browser
  // cache — this re-reads whatever is currently committed, it does NOT
  // trigger a new server-side fetch job early. That only runs on its own
  // schedule (see analyst-picks-fetcher.js's FETCH_WINDOWS_ET gate).
  const url = `https://raw.githubusercontent.com/${repo}/${TOP_PICKS_DATA_BRANCH}/${TOP_PICKS_DATA_PATH}?t=${Date.now()}`;

  let data;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { renderTopPicks('analyst-picks-data.json not found yet — waiting for first pre-market workflow run.'); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    renderTopPicks(`Fetch failed: ${e.message}`);
    return;
  } finally {
    if (manual && btn) { btn.disabled = false; btn.textContent = '⟳ REFRESH'; }
  }

  STATE.topPicksItems     = Array.isArray(data.items) ? data.items : [];
  STATE.topPicksFetchedAt = data.fetchedAt || 0;
  STATE.topPicksSource    = data.source || '';
  renderTopPicks();
}

function _fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

const SIGNAL_STYLE = {
  both:           { label: '⭐ UPGRADE + EARNINGS',  color: 'var(--bull)' },
  upgrade:        { label: '▲ UPGRADE',              color: 'var(--bull)' },
  downgrade:      { label: '▼ DOWNGRADE',            color: 'var(--bear)' },
  'consensus-up':   { label: '▲ CONSENSUS RISING',   color: 'var(--bull)' },
  'consensus-down': { label: '▼ CONSENSUS FALLING',  color: 'var(--bear)' },
  earnings:       { label: '📅 EARNINGS',            color: 'var(--text-dim)' },
};

function renderTopPicks(noteMsg) {
  const badge = document.getElementById('top-picks-badge');
  const body  = document.getElementById('top-picks-body');
  if (!body) return;

  const items = STATE.topPicksItems || [];

  if (!items.length && !STATE.topPicksFetchedAt) {
    if (badge) badge.textContent = 'no data yet';
    body.innerHTML = `<div style="padding:16px;font-family:var(--mono);font-size:10px;color:var(--text-dim);line-height:1.7;">
      No analyst-picks data yet.<br>
      ${noteMsg ? noteMsg.substring(0,160) + '<br>' : ''}
      This tab reads <code style="color:var(--text-bright)">scripts/analyst-picks-data.json</code>, written 4x/day (pre-market, mid-morning, midday, after-close) by <code>analyst-picks-fetcher.js</code>.<br><br>
      For a broader earnings calendar (not just your watchlist), add <code style="color:var(--text-bright)">FINNHUB_API_KEY</code> as a GitHub repo secret — free tier, no card required, from finnhub.io. Note: individual firm-by-firm rating changes are always limited to your watchlist + Nasdaq-100 via Yahoo — Finnhub's upgrade-downgrade endpoint requires a paid plan. When Yahoo has no specific action for a symbol, a free Finnhub key also unlocks a consensus buy/hold/sell fallback (rising/falling analyst sentiment) instead of nothing.
    </div>`;
    return;
  }

  if (badge) {
    const src = STATE.topPicksSource === 'yahoo+finnhub' ? 'Yahoo ratings + Finnhub earnings' : 'Yahoo only';
    badge.textContent = `${items.length} items · ${src} · updated ${_fmtDate(STATE.topPicksFetchedAt)}`;
  }

  if (!items.length) {
    body.innerHTML = `<div style="padding:20px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);">${noteMsg ? noteMsg.substring(0,140) : 'No rating changes or upcoming earnings matched in the current window.'}</div>`;
    return;
  }

  const rows = items.map(it => {
    const sig = SIGNAL_STYLE[it.signal] || SIGNAL_STYLE.earnings;
    const ratingLine = (it.ratingFrom || it.ratingTo)
      ? `<span style="font-family:var(--mono);font-size:9.5px;color:var(--text-bright);">${it.ratingFrom || '?'} → ${it.ratingTo || '?'}</span>${it.firm ? ` <span style="color:var(--text-dim);">(${it.firm})</span>` : ''}`
      : (it.recTrend
        ? `<span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);">Consensus: ${it.recTrend.strongBuy + it.recTrend.buy} Buy / ${it.recTrend.hold} Hold / ${it.recTrend.sell + it.recTrend.strongSell} Sell</span>`
        : '');
    const earnLine = it.earningsDate
      ? `<span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);">Earnings ${_fmtDate(it.earningsDate)}${it.daysToEarnings != null ? ` (${it.daysToEarnings}d)` : ''}</span>`
      : '';

    return `
    <div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-bright);font-weight:600;">${it.symbol}</span>
        <span style="font-family:var(--mono);font-size:8.5px;color:${sig.color};">${sig.label}</span>
      </div>
      <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);">${it.company || ''}</div>
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">
        <span>${ratingLine}</span>
        <span>${earnLine}</span>
      </div>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div>${rows}</div>
    <div style="margin-top:8px;">
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">Display-only · screening list for manual review, not a buy signal · verify the actual rating/date before acting · updated 4x/day (pre-market, mid-morning, midday, after-close)</span>
    </div>`;
}
