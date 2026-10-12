// Market-data sources. Both return candles shaped {t,o,h,l,c,v} (t = bar open, ms)
// and contract specs shaped like MexcPublicClient.fetchContractSpec().
import { MexcPublicClient } from './mexcApi.js';
import { TIMEFRAME_MS } from './config.js';

export class MexcMarketData {
  constructor(cfg) {
    this.kind = 'mexc';
    this.client = new MexcPublicClient(cfg.mexcPublicBase);
    this.specs = new Map();
  }

  async candles(symbol, bars) {
    return this.client.fetchKlines(symbol, bars);
  }

  async spec(symbol) {
    if (!this.specs.has(symbol)) this.specs.set(symbol, await this.client.fetchContractSpec(symbol));
    return this.specs.get(symbol);
  }
}

// ---- Synthetic feed -------------------------------------------------------
// Deterministic random-walk candles with alternating regimes (trend, chop,
// high-volatility). Used for offline demos and tests; never for real trading.

const EPOCH = Date.UTC(2026, 0, 1);
const REGIMES = [
  { name: 'trend-up', drift: 0.0012, sigma: 0.0045, revert: 0 },
  { name: 'trend-down', drift: -0.0012, sigma: 0.0045, revert: 0 },
  { name: 'chop', drift: 0, sigma: 0.0022, revert: 0.25 },
  { name: 'high-vol', drift: 0, sigma: 0.0095, revert: 0.02 },
];

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START_PRICES = { BTC: 98000, ETH: 3900, SOL: 210, XRP: 2.4, DOGE: 0.2 };

class SyntheticSeries {
  constructor(symbol) {
    this.symbol = symbol;
    const base = symbol.split('_')[0];
    this.rng = mulberry32(hashString(symbol));
    this.price = START_PRICES[base] ?? 50 + (hashString(base) % 500);
    this.bars = [];
    this.regime = REGIMES[0];
    this.regimeLeft = 0;
    this.nextT = EPOCH;
  }

  gauss() {
    const u = Math.max(1e-12, this.rng());
    const v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  extendTo(lastOpenT) {
    while (this.nextT <= lastOpenT) {
      if (this.regimeLeft <= 0) {
        this.regime = REGIMES[Math.floor(this.rng() * REGIMES.length)];
        this.regimeLeft = 25 + Math.floor(this.rng() * 90);
      }
      this.regimeLeft--;
      const open = this.price;
      const r = this.regime;
      const anchor = START_PRICES[this.symbol.split('_')[0]] ?? open;
      const pull = r.revert ? -r.revert * Math.log(open / anchor) : 0;
      const ret = r.drift + pull + r.sigma * this.gauss();
      const close = open * Math.exp(ret);
      const wickUp = Math.abs(this.gauss()) * r.sigma * open * 0.6;
      const wickDn = Math.abs(this.gauss()) * r.sigma * open * 0.6;
      const high = Math.max(open, close) + wickUp;
      const low = Math.min(open, close) - wickDn;
      const vol = (500 + this.rng() * 1500) * (r.sigma / 0.003);
      this.bars.push({ t: this.nextT, o: open, h: high, l: low, c: close, v: vol });
      this.price = close;
      this.nextT += TIMEFRAME_MS;
    }
  }
}

export class SyntheticMarketData {
  constructor() {
    this.kind = 'synthetic';
    this.series = new Map();
  }

  candles(symbol, bars, nowMs = Date.now()) {
    if (!this.series.has(symbol)) this.series.set(symbol, new SyntheticSeries(symbol));
    const s = this.series.get(symbol);
    // Only bars whose open time is <= the current forming bar.
    const currentOpen = Math.floor(nowMs / TIMEFRAME_MS) * TIMEFRAME_MS;
    s.extendTo(currentOpen);
    return Promise.resolve(s.bars.filter((b) => b.t <= currentOpen).slice(-bars));
  }

  spec(symbol) {
    const base = symbol.split('_')[0];
    const price = START_PRICES[base] ?? 50;
    // Approximate MEXC contract sizes (base units per contract) for simulation only.
    const contractSize = { BTC: 0.0001, ETH: 0.001, SOL: 0.01 }[base] ?? 0.01;
    return Promise.resolve({
      symbol,
      contractSize,
      volUnit: 1,
      minVol: 1,
      volScale: 0,
      priceUnit: price >= 1000 ? 0.1 : price >= 10 ? 0.01 : 0.0001,
      priceScale: 2,
      takerFeeRate: 0.0006,
      makerFeeRate: 0.0002,
      maxLeverage: 125,
      apiAllowed: true,
      state: 0,
    });
  }
}
