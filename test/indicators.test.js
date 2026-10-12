import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsi, rma, choppinessIndex, isPivotLow, atr, sma } from '../src/indicators.js';

test('rsi is 100 for a strictly rising series and 0 for a strictly falling one', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  const down = Array.from({ length: 60 }, (_, i) => 200 - i);
  const ru = rsi(up, 16);
  const rd = rsi(down, 16);
  assert.equal(ru[59], 100);
  assert.equal(rd[59], 0);
  assert.ok(Number.isNaN(ru[10]), 'RSI is undefined during warm-up');
});

test('rma seeds with an SMA of the first `length` values, then applies Wilder smoothing', () => {
  const out = rma([1, 2, 3, 4, 5, 6], 3);
  assert.ok(Number.isNaN(out[1]));
  assert.equal(out[2], 2); // mean(1,2,3)
  assert.ok(Math.abs(out[3] - ((1 / 3) * 4 + (2 / 3) * 2)) < 1e-12); // alpha*x + (1-alpha)*prev
});

test('rsi of an alternating series sits near 50', () => {
  const s = Array.from({ length: 200 }, (_, i) => (i % 2 ? 100 : 101));
  const r = rsi(s, 16);
  assert.ok(Math.abs(r[199] - 50) < 5, `expected ~50, got ${r[199]}`);
});

test('choppiness index is low for a steady trend and high for a sideways range', () => {
  const n = 120;
  const trendH = Array.from({ length: n }, (_, i) => 100 + i * 1.0 + 0.5);
  const trendL = Array.from({ length: n }, (_, i) => 100 + i * 1.0 - 0.5);
  const trendC = Array.from({ length: n }, (_, i) => 100 + i * 1.0);
  // Zig-zag between 100 and 101: every bar reverses, no net progress.
  const chopC = Array.from({ length: n }, (_, i) => (i % 2 ? 101 : 100));
  const chopH = chopC.map((c) => c + 0.5);
  const chopL = chopC.map((c) => c - 0.5);
  const trend = choppinessIndex(trendH, trendL, trendC, 14)[n - 1];
  const chop = choppinessIndex(chopH, chopL, chopC, 14)[n - 1];
  assert.ok(trend < 38.2, `trend CHOP ${trend}`);
  assert.ok(chop > 61.8, `sideways CHOP ${chop}`);
});

test('pivot low detection requires the centre to be the window minimum', () => {
  const v = [5, 4, 3, 1, 3, 4, 5];
  assert.equal(isPivotLow(v, 3, 3, 3), true);
  assert.equal(isPivotLow(v, 2, 2, 2), false);
  assert.equal(isPivotLow(v, 3, 4, 3), false, 'not enough bars on the left');
});

test('atr and sma produce values aligned with the input length', () => {
  const h = Array.from({ length: 40 }, (_, i) => 10 + i * 0.1 + 0.5);
  const l = Array.from({ length: 40 }, (_, i) => 10 + i * 0.1 - 0.5);
  const c = Array.from({ length: 40 }, (_, i) => 10 + i * 0.1);
  assert.equal(atr(h, l, c, 14).length, 40);
  const s = sma([1, 2, 3, 4, 5], 3);
  assert.equal(s[4], 4);
});
