import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEntry } from '../src/strategy.js';
import { loadConfig } from '../src/config.js';

const cfg = { ...loadConfig(), leverage: 10, riskMarginPct: 8, rewardRatio: 2, maxOpenPositions: 3, minStopPct: 0.1, maxStopPct: 8.5, stopBufferPct: 0, staleSignalSeconds: 300 };
const spec = { contractSize: 1, volUnit: 1, minVol: 1, volScale: 0, priceUnit: 0.01, takerFeeRate: 0.0006 };
const tradable = { status: 'TRADEABLE', tradable: true, chop: 40, volRatio: 1.2, reason: 'ok' };
const account = { equity: 1000, available: 1000, balance: 1000 };

const base = (over = {}) => ({
  signal: { type: 'BULL', index: 100, swingIndex: 95, swingTime: 0, swingPrice: 99, rsi: 25, prevRsi: 20, ...over.signal },
  bar: { t: 1000, o: 99.5, h: 100.5, l: 99.4, c: 100, v: 1 },
  regime: over.regime ?? tradable,
  account: over.account ?? account,
  openPositions: over.openPositions ?? [],
  symbol: 'BTC_USDT',
  spec,
  config: { ...cfg, ...(over.config || {}) },
});

test('bull divergence opens a LONG with stop at swing low and TP at 1:2', () => {
  const d = decideEntry(base());
  assert.equal(d.action, 'ENTER');
  const p = d.plan;
  assert.equal(p.side, 'LONG');
  assert.equal(p.stop, 99);
  assert.equal(p.takeProfit, 102, '100 + 2 * (100 - 99)');
  assert.equal(p.rr, 2);
  assert.ok(Math.abs(p.stopPct - 1) < 1e-9);
});

test('bear divergence opens a SHORT with stop at swing high and TP at 1:2', () => {
  const d = decideEntry(base({ signal: { type: 'BEAR', swingPrice: 101 } }));
  assert.equal(d.action, 'ENTER');
  assert.equal(d.plan.side, 'SHORT');
  assert.equal(d.plan.stop, 101);
  assert.equal(d.plan.takeProfit, 98, '100 - 2 * (101 - 100)');
});

test('position size is 8% of equity as margin with 10x leverage (80% notional)', () => {
  const p = decideEntry(base()).plan;
  assert.equal(p.margin, 80, '8% of 1000');
  assert.equal(p.notional, 800, '10x of margin');
  assert.equal(p.contracts, 8, '800 notional / price 100 with contractSize 1');
});

test('choppy market blocks entry', () => {
  const d = decideEntry(base({ regime: { status: 'CHOPPY', tradable: false, reason: 'choppy market (CHOP 70)' } }));
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /choppy/);
});

test('low-volatility market blocks entry', () => {
  const d = decideEntry(base({ regime: { status: 'LOW_VOL', tradable: false, reason: 'low volatility' } }));
  assert.equal(d.action, 'SKIP');
});

test('a stop further than the safety cap is skipped', () => {
  const d = decideEntry(base({ signal: { swingPrice: 90 } }));
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /too far/);
});

test('if price already traded through the swing stop, no trade', () => {
  const d = decideEntry(base({ signal: { swingPrice: 101 } }));
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /beyond the swing stop/);
});

test('only one open position per symbol and max open positions are respected', () => {
  const same = decideEntry(base({ openPositions: [{ symbol: 'BTC_USDT' }] }));
  assert.equal(same.action, 'SKIP');
  const full = decideEntry(base({ openPositions: [{ symbol: 'ETH_USDT' }, { symbol: 'SOL_USDT' }, { symbol: 'XRP_USDT' }] }));
  assert.equal(full.action, 'SKIP');
  assert.match(full.reason, /max open/);
});

test('insufficient margin is skipped', () => {
  const d = decideEntry(base({ account: { equity: 1000, available: 10, balance: 1000 } }));
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /insufficient/);
});
