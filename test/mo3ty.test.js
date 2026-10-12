import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMo3ty } from '../src/mo3ty.js';
import { candlesFromCloses } from './helpers.js';

// Builds a price path with two lower lows where the second trough has a higher RSI
// (classic bullish divergence), and optionally a bearish mirror image.
function divergencePath({ bearish = false } = {}) {
  const s = bearish ? -1 : 1;
  const p = [];
  const base = 100;
  // flat warm-up with small wiggle
  for (let i = 0; i < 40; i++) p.push(base + (i % 2 ? 0.3 : -0.3));
  // first leg: sharp move down 20 bars (RSI collapses)
  for (let i = 1; i <= 20; i++) p.push(base - i * 1.0 * s);
  // rally 10 bars
  const first = base - 20 * s;
  for (let i = 1; i <= 10; i++) p.push(first + i * 0.8 * s);
  // second leg: slower decline, makes a more extreme price
  const mid = first + 8 * s;
  for (let i = 1; i <= 16; i++) p.push(mid - i * 0.6 * s);
  // a few bars of confirmation after the second extreme
  const second = mid - 16 * 0.6 * s;
  for (let i = 1; i <= 8; i++) p.push(second + i * 0.5 * s);
  return p.map((x) => x);
}

test('bullish divergence is detected once the pivot is confirmed (5 bars later)', () => {
  const closes = divergencePath();
  // Make the second trough a strictly lower low by nudging its close/low.
  const candles = candlesFromCloses(closes, { wick: 0.1 });
  const result = computeMo3ty(candles, { useDivergenceZoneFilter: true });
  const bulls = result.signals.filter((s) => s.type === 'BULL');
  assert.ok(bulls.length >= 1, `expected a bull divergence, signals=${JSON.stringify(result.signals.map((s) => s.type))}`);
  const sig = bulls[bulls.length - 1];
  assert.equal(sig.index - sig.swingIndex, 5, 'confirmation happens pivotRight bars after the swing');
  assert.equal(sig.swingPrice, candles[sig.swingIndex].l, 'stop reference is the swing low price');
  assert.ok(sig.swingPrice < sig.prevSwingPrice, 'swing low makes a lower low');
  assert.ok(sig.rsi > sig.prevRsi, 'RSI makes a higher low');
});

test('no divergence when price keeps falling with the RSI also falling (no structure)', () => {
  const closes = [];
  for (let i = 0; i < 160; i++) closes.push(200 - i * 0.5 + Math.sin(i / 3) * 1.5);
  const candles = candlesFromCloses(closes);
  const result = computeMo3ty(candles);
  const bulls = result.signals.filter((s) => s.type === 'BULL');
  // Steady downtrend: lows keep falling AND RSI keeps falling -> no bullish divergence.
  assert.equal(bulls.length, 0);
});

test('bearish divergence mirrors the bullish logic with swing highs', () => {
  const closes = divergencePath({ bearish: true });
  const candles = candlesFromCloses(closes, { wick: 0.1 });
  const result = computeMo3ty(candles);
  const bears = result.signals.filter((s) => s.type === 'BEAR');
  assert.ok(bears.length >= 1, 'expected a bear divergence');
  const sig = bears[bears.length - 1];
  assert.equal(sig.swingPrice, candles[sig.swingIndex].h);
  assert.ok(sig.swingPrice > sig.prevSwingPrice);
  assert.ok(sig.rsi < sig.prevRsi);
});

test('signals are never emitted for bars that have not been confirmed yet', () => {
  const candles = candlesFromCloses(divergencePath());
  const result = computeMo3ty(candles);
  for (const s of result.signals) {
    assert.ok(s.index < candles.length);
    assert.ok(s.index - s.swingIndex >= 5);
  }
});
