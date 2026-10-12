// Market-regime gate: the only filter beyond the Mo3ty divergence itself.
// Per the rules: never trade choppy markets, only trade high-volatility markets.
//   CHOPPY  -> Choppiness Index above the choppy-zone threshold (default 61.8)
//   LOW_VOL -> ATR(14) below its own 50-bar average times VOL_RATIO_MIN (default 1.0)
//   TRADEABLE otherwise (both longs and shorts).

import { atr, choppinessIndex, sma } from './indicators.js';

export const REGIME_DEFAULTS = Object.freeze({
  chopPeriod: 14,
  chopMax: 61.8,
  atrPeriod: 14,
  atrBasePeriod: 50,
  volRatioMin: 1.0,
});

export function computeRegime(candles, options = {}) {
  const o = { ...REGIME_DEFAULTS, ...options };
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const close = candles.map((c) => c.c);
  const chop = choppinessIndex(high, low, close, o.chopPeriod);
  const atrVals = atr(high, low, close, o.atrPeriod);
  const atrBase = sma(atrVals, o.atrBasePeriod);
  const volRatio = atrVals.map((a, i) => (Number.isFinite(a) && Number.isFinite(atrBase[i]) && atrBase[i] > 0 ? a / atrBase[i] : NaN));
  return { chop, volRatio, atr: atrVals, options: o };
}

export function regimeAt(regime, index) {
  const chop = regime.chop[index];
  const volRatio = regime.volRatio[index];
  const o = regime.options;
  if (!Number.isFinite(chop) || !Number.isFinite(volRatio)) {
    return { status: 'WARMUP', tradable: false, chop, volRatio, reason: 'indicator warm-up' };
  }
  if (chop > o.chopMax) {
    return {
      status: 'CHOPPY',
      tradable: false,
      chop,
      volRatio,
      reason: `choppy market (CHOP ${chop.toFixed(1)} > ${o.chopMax})`,
    };
  }
  if (volRatio < o.volRatioMin) {
    return {
      status: 'LOW_VOL',
      tradable: false,
      chop,
      volRatio,
      reason: `low volatility (ATR ratio ${volRatio.toFixed(2)} < ${o.volRatioMin})`,
    };
  }
  return { status: 'TRADEABLE', tradable: true, chop, volRatio, reason: 'high-volatility trending market' };
}
