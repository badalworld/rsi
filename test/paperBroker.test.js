import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker } from '../src/paperBroker.js';

const plan = (over = {}) => ({
  symbol: 'BTC_USDT', side: 'LONG', divergence: 'BULL', entry: 100, stop: 99, takeProfit: 102,
  rr: 2, stopPct: 1, contracts: 8, qty: 8, notional: 800, margin: 80, leverage: 10,
  feeRate: 0.0006, signalTime: 0, regime: 'TRADEABLE', chop: 40, volRatio: 1.2, ...over,
});
const bar = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });
const TF = 15 * 60 * 1000;

test('stop-loss exit books the loss plus both taker fees', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan(), 0);
  const closed = b.manage('BTC_USDT', [bar(TF, 100, 100.2, 98.5, 99)], 0);
  assert.equal(closed.length, 1);
  const t = closed[0];
  assert.equal(t.exitReason, 'STOP_LOSS');
  assert.equal(t.exit, 99);
  const fees = 800 * 0.0006 + 8 * 99 * 0.0006;
  assert.ok(Math.abs(t.pnl - (-8 - fees)) < 1e-9, `pnl ${t.pnl}`);
  assert.ok(Math.abs(b.balance - (1000 + t.pnl)) < 1e-9, 'balance equals start + net pnl');
  assert.equal(b.positions.length, 0);
});

test('take-profit at 1:2 books 2R gross', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan(), 0);
  const [t] = b.manage('BTC_USDT', [bar(TF, 100.5, 102.5, 100.1, 102)], 0);
  assert.equal(t.exitReason, 'TAKE_PROFIT');
  assert.equal(t.exit, 102);
  assert.ok(Math.abs(t.rMultiple - t.pnl / 8) < 1e-9, 'R = pnl / initial risk (8 * 1)');
  assert.ok(t.pnl > 0);
  assert.ok(Math.abs((t.pnl + t.fees) / 8 - 2) < 1e-9, 'gross PnL equals 2R before fees');
});

test('when a single candle touches both stop and target, the stop is assumed first', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan(), 0);
  const [t] = b.manage('BTC_USDT', [bar(TF, 100, 103, 98, 100)], 0);
  assert.equal(t.exitReason, 'STOP_LOSS');
});

test('a gap through the stop fills at the open, not at the stop', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan(), 0);
  const [t] = b.manage('BTC_USDT', [bar(TF, 98.7, 98.9, 98.5, 98.6)], 0);
  assert.equal(t.exit, 98.7);
});

test('bars at or before the entry bar are never used for exits', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan({ signalTime: 5 * TF }), 0);
  const closed = b.manage('BTC_USDT', [bar(5 * TF, 100, 100, 90, 95)], 0);
  assert.equal(closed.length, 0, 'the signal candle itself must not trigger the stop');
});

test('short position: stop above entry, target below', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan({ side: 'SHORT', stop: 101, takeProfit: 98 }), 0);
  const [t] = b.manage('BTC_USDT', [bar(TF, 100, 101.2, 99.8, 100.5)], 0);
  assert.equal(t.exitReason, 'STOP_LOSS');
  assert.ok(t.pnl < 0);
  b.open(plan({ side: 'SHORT', stop: 101, takeProfit: 98, signalTime: 10 * TF }), 0);
  const [w] = b.manage('BTC_USDT', [bar(11 * TF, 100, 100.2, 97.5, 98)], 0);
  assert.equal(w.exitReason, 'TAKE_PROFIT');
  assert.ok(w.pnl > 0);
});

test('account exposes available margin after reserving margin for open positions', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  b.open(plan(), 0);
  const a = b.account();
  assert.ok(a.marginUsed > 79.9 && a.marginUsed < 80.1);
  assert.ok(a.available < 1000 - 79);
});

test('liquidation closes the position for a loss equal to its margin', () => {
  const b = new PaperBroker({ startBalance: 1000, slippagePct: 0 });
  // Deliberately wide stop beyond liquidation to exercise the liquidation branch.
  b.open(plan({ stop: 80, takeProfit: 120 }), 0);
  const [t] = b.manage('BTC_USDT', [bar(TF, 100, 100, 85, 90)], 0);
  assert.equal(t.exitReason, 'LIQUIDATED');
  assert.ok(Math.abs(t.pnl + 80) < 1, 'loses the margin (plus entry fee)');
  assert.ok(Math.abs(b.balance - (1000 + t.pnl)) < 1e-9, 'balance equals start + net pnl');
});
