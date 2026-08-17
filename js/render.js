/**
 * render.js - Dashboard Rendering Engine & Dynamic Color Ramp Generators
 */

window.RenderEngine = (function () {

  /**
   * Calculates green signal intensity dynamic styling based on conviction score (0 - 100)
   * @param {number} convictionScore 
   * @returns {Object} CSS style properties
   */
  function getBuySignalStyle(convictionScore = 50) {
    const score = Math.max(0, Math.min(100, convictionScore));
    const opacity = (0.35 + (score / 100) * 0.65).toFixed(2);
    const glowRadius = Math.round((score / 100) * 12);
    
    return {
      color: '#00e5a0',
      backgroundColor: `rgba(0, 229, 160, ${opacity * 0.15})`,
      border: `1px solid rgba(0, 229, 160, ${opacity})`,
      boxShadow: `0 0 ${glowRadius}px rgba(0, 229, 160, ${opacity * 0.4})`
    };
  }

  /**
   * Generates a smooth Yellow -> Red dynamic gradient style for CHASING / EXTENDED signals
   * @param {number} penaltySeverity (0 = Mild/Yellow, 100 = Severe/Red)
   * @returns {Object} CSS style properties
   */
  function getChasingSignalStyle(penaltySeverity = 0) {
    const severity = Math.max(0, Math.min(100, penaltySeverity));
    const factor = severity / 100;

    // RGB Interpolation: Yellow (245, 197, 24) -> Red (255, 59, 92)
    const r = Math.round(245 + (255 - 245) * factor);
    const g = Math.round(197 - (197 - 59) * factor);
    const b = Math.round(24 + (92 - 24) * factor);

    const rgbStr = `${r}, ${g}, ${b}`;

    return {
      color: `rgb(${rgbStr})`,
      backgroundColor: `rgba(${rgbStr}, 0.12)`,
      border: `1px solid rgba(${rgbStr}, 0.6)`,
      boxShadow: `0 0 ${Math.round(4 + factor * 8)}px rgba(${rgbStr}, 0.3)`
    };
  }

  /**
   * Generates fixed severe crimson styling for high-risk signals (FALLING KNIFE / EXHAUSTED)
   * @returns {Object} CSS style properties
   */
  function getSevereRiskSignalStyle() {
    return {
      color: '#ff3b5c',
      backgroundColor: 'rgba(217, 4, 41, 0.18)',
      border: '1px solid #d90429',
      boxShadow: '0 0 10px rgba(217, 4, 41, 0.4)'
    };
  }

  /**
   * Resolves component styles based on signal type and conviction parameters
   * @param {string} signalType 
   * @param {number} scoreOrSeverity 
   */
  function resolveSignalBadgeStyle(signalType, scoreOrSeverity = 50) {
    const type = (signalType || '').toUpperCase();

    switch (type) {
      case 'BUY':
      case 'STRONG_BUY':
      case 'ACCUMULATE':
        return getBuySignalStyle(scoreOrSeverity);

      case 'CHASING':
      case 'EXTENDED':
        return getChasingSignalStyle(scoreOrSeverity);

      case 'FALLING_KNIFE':
      case 'EXHAUSTED':
      case 'SELL':
        return getSevereRiskSignalStyle();

      default:
        return {
          color: '#8a8f9d',
          backgroundColor: 'rgba(138, 143, 157, 0.1)',
          border: '1px solid #8a8f9d',
          boxShadow: 'none'
        };
    }
  }

  /**
   * Primary entry point for rendering dashboard matrix cards
   * @param {Object} data 
   */
  function renderDashboard(data) {
    const container = document.getElementById('matrix-container');
    if (!container || !data || !Array.isArray(data.assets)) return;

    container.innerHTML = '';

    data.assets.forEach((asset) => {
      const card = document.createElement('div');
      card.className = 'asset-card';

      const styleObj = resolveSignalBadgeStyle(
        asset.signal, 
        asset.conviction || asset.extensionPenalty || 50
      );

      const inlineCss = Object.entries(styleObj)
        .map(([key, val]) => `${key.replace(/([A-Z])/g, '-$1').toLowerCase()}:${val}`)
        .join(';');

      card.innerHTML = `
        <div class="asset-header">
          <span class="asset-symbol">${asset.symbol}</span>
          <span class="signal-badge" style="${inlineCss}">${asset.signal}</span>
        </div>
        <div class="asset-body">
          <div class="metric-row">
            <span>Price:</span>
            <span>$${asset.price ? asset.price.toLocaleString() : 'N/A'}</span>
          </div>
          <div class="metric-row">
            <span>Bias / Score:</span>
            <span>${asset.conviction ? asset.conviction + '/100' : 'N/A'}</span>
          </div>
        </div>
      `;

      container.appendChild(card);
    });
  }

  return {
    renderDashboard,
    resolveSignalBadgeStyle
  };

})();