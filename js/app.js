/**
 * app.js - Main Application Logic & State Controller
 */

const STATE = {
  marketData: null,
  lastSyncTimestamp: null,
  autoRefreshInterval: null,
};

// DOM Content Loaded Initializer
document.addEventListener('DOMContentLoaded', async () => {
  initEventListeners();
  await fetchMarketData();
  startAutoRefresh(60000); // Auto refresh every 60s
});

/**
 * Initializes UI Event Listeners
 */
function initEventListeners() {
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('spinning');
      await fetchMarketData(true);
      refreshBtn.classList.remove('spinning');
    });
  }
}

/**
 * Fetches market-data.json and updates application state
 * @param {boolean} forceBustCache 
 */
async function fetchMarketData(forceBustCache = false) {
  try {
    const url = forceBustCache 
      ? `./market-data.json?t=${Date.now()}` 
      : './market-data.json';

    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    STATE.marketData = data;
    
    // Set timestamp from JSON payload if present, fallback to client fetch time
    STATE.lastSyncTimestamp = data.timestamp ? new Date(data.timestamp) : new Date();

    updateMarketDataAgeUI();
    
    if (window.RenderEngine && typeof window.RenderEngine.renderDashboard === 'function') {
      window.RenderEngine.renderDashboard(STATE.marketData);
    }
  } catch (error) {
    console.error('Failed to fetch market data:', error);
    showDataFetchErrorUI();
  }
}

/**
 * Updates UI timestamps showing market data age accurately
 */
function updateMarketDataAgeUI() {
  const ageDisplayEl = document.getElementById('market-data-age');
  if (!ageDisplayEl || !STATE.lastSyncTimestamp) return;

  const now = new Date();
  const diffMs = Math.max(0, now - STATE.lastSyncTimestamp);
  const diffSecs = Math.floor(diffMs / 1000);

  let formattedAge = '';
  if (diffSecs < 60) {
    formattedAge = `${diffSecs}s ago`;
  } else if (diffSecs < 3600) {
    formattedAge = `${Math.floor(diffSecs / 60)}m ago`;
  } else {
    formattedAge = `${Math.floor(diffSecs / 3600)}h ago`;
  }

  ageDisplayEl.textContent = `Updated: ${STATE.lastSyncTimestamp.toLocaleTimeString()} (${formattedAge})`;
}

/**
 * Periodically updates the relative time display without network overhead
 */
function startAutoRefresh(intervalMs) {
  if (STATE.autoRefreshInterval) clearInterval(STATE.autoRefreshInterval);
  
  // Background age ticker
  setInterval(() => {
    updateMarketDataAgeUI();
  }, 5000);

  // Network refresh interval
  STATE.autoRefreshInterval = setInterval(() => {
    fetchMarketData(true);
  }, intervalMs);
}

function showDataFetchErrorUI() {
  const ageDisplayEl = document.getElementById('market-data-age');
  if (ageDisplayEl) {
    ageDisplayEl.textContent = 'Error loading data';
    ageDisplayEl.classList.add('text-error');
  }
}