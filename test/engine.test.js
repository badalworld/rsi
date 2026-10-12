import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { PaperBroker } from '../src/paperBroker.js';
import { SyntheticMarketData } from '../src/marketData.js';
import { MemoryStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { buildSnapshot } from '../src/snapshot.js';

const TF = 15 * 60 * 1000;
const START = Date.UTC(2026, 0, 1) + 800 * TF; // ~8 days of synthetic history before the first tick

function makeEngine(overrides = {}) {
  const cfg = {
    ...loadConfig(),
    mode: 'paper',
    dataSource: 'synthetic',
    symbols: ['BTC_USDT', 'ETH_USDT'],
    startBalance: 1000,
    ...overrides,
  };
  let clock = START;
  const broker = new PaperBroker({ startBalance: cfg.startBalance, slippagePct: cfg.paperSlippagePct, leverage: cfg.leverage });
  const engine = new Engine({
    cfg,
    marketData: new SyntheticMarketData(),
    broker,
    store: new MemoryStore(),
    log: () => {},
    now: () => clock,
  });
  return {
    engine,
    cfg,
    broker,
    advance: (ms) => { clock += ms; },
    setClock: (t) => { clock = t; },
  };
}

test('engine runs many polls on synthetic data with no symbol errors and consistent accounting', async () => {
  const { engine, broker, advance } = makeEngine();
  await engine.init();
  assert.deepEqual(engine.symbolErrors, {});
  for (let i = 0; i < 300; i++) {
    await engine.tick();
    advance(TF);
  }
  assert.equal(engine.state.lastError, null, `unexpected error: ${JSON.stringify(engine.state.lastError)}`);
  const snap = engine.snapshot();
  assert.equal(snap.symbols.length, 2);
  for (const s of snap.symbols) assert.equal(s.status, 'OK');

  // Accounting: balance = start + sum of realised pnl; trades never exceed sizing caps.
  const realised = broker.trades.reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(broker.balance - (1000 + realised)) < 1e-6, `balance ${broker.balance} vs ${1000 + realised}`);
  for (const t of broker.trades) {
    assert.ok(t.exitReason);
    assert.ok(Math.abs(t.margin - 80) < 1.0 || t.margin < 80.5, `margin ${t.margin} should be ~8% of balance`);
  }
});

test('each signal bar is processed at most once', async () => {
  const { engine, advance } = makeEngine();
  await engine.init();
  for (let i = 0; i < 200; i++) {
    await engine.tick();
    await engine.tick(); // second poll inside the same bar must not duplicate anything
    advance(TF);
  }
  const keys = engine.state.signals.map((s) => `${s.symbol}|${s.barT}|${s.type}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate signal events');
});

test('executed signals always have the 8% margin / 1:2 target structure', async () => {
  const { engine, advance } = makeEngine({ symbols: ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'] });
  await engine.init();
  for (let i = 0; i < 1200; i++) {
    await engine.tick();
    advance(TF);
  }
  const executed = engine.state.signals.filter((s) => s.action === 'EXECUTED');
  for (const s of executed) {
    const risk = Math.abs(s.price - s.stop);
    if (s.side === 'LONG') {
      assert.ok(s.stop < s.price, 'long stop below entry');
      assert.ok(Math.abs(s.takeProfit - (s.price + 2 * risk)) < 0.05 + 2 * risk * 0.001, 'long TP = 1:2');
    } else {
      assert.ok(s.stop > s.price, 'short stop above entry');
      assert.ok(Math.abs(s.takeProfit - (s.price - 2 * risk)) < 0.05 + 2 * risk * 0.001, 'short TP = 1:2');
    }
    assert.ok(Math.abs(s.margin - 80) < 1.0 || s.margin < 80.5, `margin ${s.margin}`);
  }
  // Every executed trade must have been in a tradable regime.
  for (const s of executed) assert.equal(s.regime, 'TRADEABLE');
  // Every choppy/low-vol skip must not have executed.
  for (const s of engine.state.signals.filter((x) => x.action === 'SKIPPED' && /choppy|low volatility/.test(x.reason))) {
    assert.notEqual(s.regime, 'TRADEABLE');
  }
});

test('snapshot exposes the dashboard contract without secrets', async () => {
  const { engine, advance, cfg } = makeEngine();
  await engine.init();
  for (let i = 0; i < 120; i++) {
    await engine.tick();
    advance(TF);
  }
  const snap = buildSnapshot({ cfg, engine, now: START + 120 * TF });
  const json = JSON.stringify(snap);
  assert.ok(!/secret|apiKey|MEXC_API/i.test(json));
  for (const key of ['status', 'account', 'stats', 'positions', 'trades', 'signals', 'equity', 'symbols', 'config']) {
    assert.ok(key in snap, `missing ${key}`);
  }
  assert.ok(snap.status.secondsToNextCandle >= 0 && snap.status.secondsToNextCandle <= 900);
});

test('PnL analytics: cumulative, daily buckets, symbol split and R histogram', async () => {
  const { computePnlAnalytics } = await import('../src/snapshot.js');
  const now = Date.UTC(2026, 9, 12, 12);
  const trades = [
    { symbol: 'BTC_USDT', side: 'LONG', pnl: 10, rMultiple: 2, exitReason: 'TAKE_PROFIT', closedAt: now - 1000 },
    { symbol: 'ETH_USDT', side: 'SHORT', pnl: -5, rMultiple: -1, exitReason: 'STOP_LOSS', closedAt: now - 2000 },
    { symbol: 'BTC_USDT', side: 'SHORT', pnl: -20, rMultiple: -2.5, exitReason: 'STOP_LOSS', closedAt: now - 2 * 24 * 3600 * 1000 },
  ];
  const a = computePnlAnalytics(trades, now);
  assert.equal(a.cumulative.at(-1).cum, -15);
  assert.equal(a.daily.length, 30);
  assert.equal(a.daily.at(-1).pnl, 5, 'today = +10 - 5');
  assert.equal(a.bySymbol[0].symbol, 'ETH_USDT', 'sorted by pnl desc: ETH -5 beats BTC -10');
  assert.equal(a.rHist.reduce((s, b) => s + b.count, 0), 3);
  assert.equal(a.rHist[0].count, 1, '-2.5R lands in the <= -2R bin');
  assert.equal(a.bestTrade.pnl, 10);
});
