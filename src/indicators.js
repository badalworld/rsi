// Pure indicator math. Every function returns arrays aligned with its input
// (NaN where the value is not yet defined). Formulas mirror TradingView's
// ta.rsi / ta.rma / ta.atr / ta.pivotlow / ta.pivothigh so the bot sees the
// same divergences as the Mo3ty RSI Pine script.

export function rma(values, length) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  const alpha = 1 / length;
  let seedSum = 0;
  let seedCount = 0;
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(prev)) {
      // Pine seeds RMA with the SMA of the first `length` valid values.
      if (!Number.isFinite(v)) {
        seedSum = 0;
        seedCount = 0;
        continue;
      }
      seedSum += v;
      seedCount++;
      if (seedCount === length) {
        prev = seedSum / length;
        out[i] = prev;
      }
    } else {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(close, length) {
  const n = close.length;
  const up = new Array(n).fill(NaN);
  const dn = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const change = close[i] - close[i - 1];
    up[i] = Math.max(change, 0);
    dn[i] = Math.max(-change, 0);
  }
  const avgUp = rma(up, length);
  const avgDn = rma(dn, length);
  return avgUp.map((u, i) => {
    const d = avgDn[i];
    if (!Number.isFinite(u) || !Number.isFinite(d)) return NaN;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  });
}

export function trueRange(high, low, close) {
  const n = high.length;
  const out = new Array(n).fill(NaN);
  if (n === 0) return out;
  out[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    out[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
  }
  return out;
}

export function atr(high, low, close, length) {
  return rma(trueRange(high, low, close), length);
}

export function sma(values, length) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (ok) out[i] = sum / length;
  }
  return out;
}

// Choppiness Index: 100 * log10( sum(TR, n) / (highest(high, n) - lowest(low, n)) ) / log10(n)
// Values near 100 = price chopping sideways; values near 0 = strong trend.
export function choppinessIndex(high, low, close, length) {
  const n = high.length;
  const out = new Array(n).fill(NaN);
  const tr = trueRange(high, low, close);
  const logN = Math.log10(length);
  for (let i = length - 1; i < n; i++) {
    let sumTr = 0;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      sumTr += tr[j];
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    const range = hh - ll;
    if (range > 0 && sumTr > 0) {
      out[i] = (100 * Math.log10(sumTr / range)) / logN;
    }
  }
  return out;
}

// True when `values[center]` is the extreme (lowest for pivot lows) of the
// window [center-left, center+right]. Ties are allowed, like ta.pivotlow.
export function isPivotLow(values, center, left, right) {
  if (center - left < 0 || center + right >= values.length) return false;
  const v = values[center];
  if (!Number.isFinite(v)) return false;
  for (let j = center - left; j <= center + right; j++) {
    if (j !== center && values[j] < v) return false;
  }
  return true;
}

export function isPivotHigh(values, center, left, right) {
  if (center - left < 0 || center + right >= values.length) return false;
  const v = values[center];
  if (!Number.isFinite(v)) return false;
  for (let j = center - left; j <= center + right; j++) {
    if (j !== center && values[j] > v) return false;
  }
  return true;
}
