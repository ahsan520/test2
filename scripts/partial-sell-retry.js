// ═════════════════════════════════════════════════════════════════
// partial-sell-retry.js — self-healing quantity precision for partial sells
//
// 2026-10-06: four position-intelligence partial sells (AVAX x3, IMX x1) failed
// with "MEXC POST /api/v3/order failed (HTTP 400): quantity scale is invalid"
// even though the quantity was already floored to the step size read from
// exchangeInfo. Without exchange data here the root cause cannot be pinned
// down, so instead of guessing: when MEXC rejects the scale, retry the SAME
// slice with one fewer decimal place, down to whole units, and stop if the
// slice would drop below MEXC's minimum notional. Pure apart from the
// injected sellFn, so it can be unit-tested with a mock.
// ═════════════════════════════════════════════════════════════════
const floorDec = (x, dec) => {
  const f = Math.pow(10, dec);
  return Math.floor(x * f + 1e-9) / f;
};

export async function sellWithScaleRetry({ sellFn, free, pct, step, firstQty, refPrice = 0, minNotional = 0, onRetry = () => {} }) {
  let dec = Math.max(0, Math.round(-Math.log10(step || 1)));
  let qty = firstQty;
  for (;;) {
    try {
      const sell = await sellFn(qty);
      return { sell, qty, decimals: dec };
    } catch (e) {
      if (!/quantity scale is invalid/i.test(e?.message || '') || dec <= 0) throw e;
      dec -= 1;
      const next = floorDec(free * pct, dec);
      onRetry({ from: qty, to: next, decimals: dec });
      if (next <= 0 || (refPrice > 0 && next * refPrice < minNotional)) throw e;
      qty = next;
    }
  }
}
