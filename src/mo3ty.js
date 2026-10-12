// Bar-for-bar port of the "Mo3ty RSI Signals and Divergence" Pine v6 script,
// restricted to the divergence logic (the only entry trigger for this bot).
//
// Pine reference (section 8 — DIVERGENCE CALCULATIONS):
//   pl = ta.pivotlow(low, pivotLeft, pivotRight)   -> confirmed on bar i = centre + pivotRight
//   currLowRSI = rsi[pivotRight]                   -> RSI at the pivot centre bar
//   bullStructure = currLow < prevLow and currLowRSI > prevLowRSI
//   bullZoneOK    = not zoneFilter or min(currLowRSI, prevLowRSI) <= oversold
//   bearStructure = currHigh > prevHigh and currHighRSI < prevHighRSI
//   bearZoneOK    = not zoneFilter or max(currHighRSI, prevHighRSI) >= overbought
//
// Divergences are only evaluated on confirmed (closed) bars. Given the same
// candle history, this produces the same bars the indicator marks on TradingView.

import { isPivotHigh, isPivotLow, rsi } from './indicators.js';

export const MO3TY_DEFAULTS = Object.freeze({
  rsiLength: 16,
  upperLevel: 70,
  lowerLevel: 30,
  pivotLeft: 5,
  pivotRight: 5,
  useDivergenceZoneFilter: true,
});

/**
 * @param {Array<{h:number,l:number,c:number}>} candles closed candles, oldest first
 * @param {object} [options] overrides for MO3TY_DEFAULTS
 * @returns {{ rsi: number[], signals: Array<object>, signalsAt: Map<number, object[]> }}
 *   signal.index is the confirmation bar (the bar whose close triggers the trade).
 *   signal.swingPrice is the pivot low (BULL) / pivot high (BEAR) used for the stop loss.
 */
export function computeMo3ty(candles, options = {}) {
  const o = { ...MO3TY_DEFAULTS, ...options };
  const n = candles.length;
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const close = candles.map((c) => c.c);
  const rsiArr = rsi(close, o.rsiLength);

  const signals = [];
  const signalsAt = new Map();
  const push = (sig) => {
    signals.push(sig);
    if (!signalsAt.has(sig.index)) signalsAt.set(sig.index, []);
    signalsAt.get(sig.index).push(sig);
  };

  // Persistent "var" state from Pine.
  let prevLowPrice = NaN;
  let prevLowRSI = NaN;
  let prevLowCentre = NaN;
  let prevHighPrice = NaN;
  let prevHighRSI = NaN;
  let prevHighCentre = NaN;

  for (let i = 0; i < n; i++) {
    const centre = i - o.pivotRight;
    if (centre < 0) continue;

    if (isPivotLow(low, centre, o.pivotLeft, o.pivotRight)) {
      const currLowPrice = low[centre];
      const currLowRSI = rsiArr[centre];
      const bullStructure =
        Number.isFinite(prevLowPrice) && currLowPrice < prevLowPrice && currLowRSI > prevLowRSI;
      const bullZoneOK =
        !o.useDivergenceZoneFilter || Math.min(currLowRSI, prevLowRSI) <= o.lowerLevel;
      if (bullStructure && bullZoneOK) {
        push({
          type: 'BULL',
          index: i,
          time: candles[i].t,
          swingIndex: centre,
          swingTime: candles[centre].t,
          swingPrice: currLowPrice,
          rsi: currLowRSI,
          prevSwingIndex: prevLowCentre,
          prevSwingPrice: prevLowPrice,
          prevRsi: prevLowRSI,
        });
      }
      prevLowPrice = currLowPrice;
      prevLowRSI = currLowRSI;
      prevLowCentre = centre;
    }

    if (isPivotHigh(high, centre, o.pivotLeft, o.pivotRight)) {
      const currHighPrice = high[centre];
      const currHighRSI = rsiArr[centre];
      const bearStructure =
        Number.isFinite(prevHighPrice) && currHighPrice > prevHighPrice && currHighRSI < prevHighRSI;
      const bearZoneOK =
        !o.useDivergenceZoneFilter || Math.max(currHighRSI, prevHighRSI) >= o.upperLevel;
      if (bearStructure && bearZoneOK) {
        push({
          type: 'BEAR',
          index: i,
          time: candles[i].t,
          swingIndex: centre,
          swingTime: candles[centre].t,
          swingPrice: currHighPrice,
          rsi: currHighRSI,
          prevSwingIndex: prevHighCentre,
          prevSwingPrice: prevHighPrice,
          prevRsi: prevHighRSI,
        });
      }
      prevHighPrice = currHighPrice;
      prevHighRSI = currHighRSI;
      prevHighCentre = centre;
    }
  }

  return { rsi: rsiArr, signals, signalsAt, options: o };
}
