export const TF = 15 * 60 * 1000;

// Build candles from a list of closes. High/low are the close +/- wick.
export function candlesFromCloses(closes, { t0 = Date.UTC(2026, 0, 1), wick = 0.2 } = {}) {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: t0 + i * TF, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000 };
  });
}
