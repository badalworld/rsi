// Replays the exact same Mo3ty divergence + regime + sizing + broker logic over
// historical 15m candles and reports performance.
//
//   npm run backtest -- --symbol BTC_USDT --bars 3000
//   npm run backtest -- --symbol ETH_USDT --bars 2000 --source synthetic
//
// Notes: uses MEXC public kline data (needs internet), fills are simulated with
// PAPER_SLIPPAGE_PCT and taker fees, and a candle is used for both entry (close)
// and exit checks only after it has closed, mirroring the live engine.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, TIMEFRAME_MS } from '../src/config.js';
import { computeMo3ty } from '../src/mo3ty.js';
import { computeRegime, regimeAt } from '../src/regime.js';
import { decideEntry } from '../src/strategy.js';
import { PaperBroker } from '../src/paperBroker.js';
import { computeStats } from '../src/snapshot.js';
import { MexcMarketData, SyntheticMarketData } from '../src/marketData.js';
import { MexcPublicClient } from '../src/mexcApi.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function fetchHistory(client, symbol, bars) {
  const chunk = 500;
  const byT = new Map();
  let end = Date.now();
  while (byT.size < bars) {
    const part = await client.fetchKlines(symbol, chunk, end);
    if (part.length === 0) break;
    for (const c of part) byT.set(c.t, c);
    const oldest = Math.min(...part.map((c) => c.t));
    if (oldest >= end) break;
    end = oldest;
  }
  const all = [...byT.values()].sort((a, b) => a.t - b.t);
  const cutoff = Date.now() - TIMEFRAME_MS;
  return all.filter((c) => c.t + TIMEFRAME_MS <= cutoff).slice(-bars);
}

async function main() {
  const cfg = loadConfig();
  const symbol = arg('symbol', cfg.symbols[0]).toUpperCase();
  const bars = Number(arg('bars', 3000));
  const source = arg('source', cfg.dataSource);

  let candles;
  let spec;
  if (source === 'synthetic') {
    const md = new SyntheticMarketData();
    const now = Date.UTC(2026, 9, 1);
    candles = (await md.candles(symbol, bars, now)).filter((c) => c.t + TIMEFRAME_MS <= now);
    spec = await md.spec(symbol);
  } else {
    const client = new MexcPublicClient(cfg.mexcPublicBase);
    candles = await fetchHistory(client, symbol, bars);
    spec = await client.fetchContractSpec(symbol);
  }
  if (candles.length < 300) throw new Error(`only ${candles.length} candles; need at least 300`);

  const ind = computeMo3ty(candles, cfg.indicator);
  const reg = computeRegime(candles, cfg);
  const broker = new PaperBroker({ startBalance: cfg.startBalance, slippagePct: cfg.paperSlippagePct, leverage: cfg.leverage, source: 'backtest' });
  const skips = {};
  const equity = [];
  const WARMUP = 250;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    broker.manage(symbol, [bar], bar.t);
    broker.markPrice(symbol, bar.c);
    const sigs = ind.signalsAt.get(i) || [];
    if (sigs.length === 1) {
      const regime = regimeAt(reg, i);
      const decision = decideEntry({
        signal: sigs[0],
        bar,
        regime,
        account: broker.account(),
        openPositions: broker.openPositions(),
        symbol,
        spec,
        config: cfg,
      });
      if (decision.action === 'ENTER') broker.open(decision.plan, bar.t);
      else skips[decision.reason.replace(/[0-9.]+/g, '#')] = (skips[decision.reason.replace(/[0-9.]+/g, '#')] || 0) + 1;
    }
    equity.push({ t: bar.t, equity: broker.account().equity });
  }
  // Mark any still-open position at the last close for reporting.
  const last = candles[candles.length - 1];
  for (const p of broker.positions.slice()) broker.close(p, last.c, 'END_OF_TEST', last.t);

  const stats = computeStats(broker.trades, cfg.startBalance, equity);
  const longs = broker.trades.filter((t) => t.side === 'LONG');
  const shorts = broker.trades.filter((t) => t.side === 'SHORT');
  const summary = {
    symbol,
    source,
    timeframe: cfg.timeframe,
    from: new Date(candles[0].t).toISOString(),
    to: new Date(last.t).toISOString(),
    candles: candles.length,
    startBalance: cfg.startBalance,
    endBalance: broker.balance,
    netPnl: stats.totalPnl,
    returnPct: stats.totalReturnPct,
    trades: stats.trades,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
    avgR: stats.avgR,
    maxDrawdownPct: stats.maxDrawdownPct,
    longs: { trades: longs.length, pnl: longs.reduce((s, t) => s + t.pnl, 0) },
    shorts: { trades: shorts.length, pnl: shorts.reduce((s, t) => s + t.pnl, 0) },
    skipReasons: skips,
    settings: { riskMarginPct: cfg.riskMarginPct, leverage: cfg.leverage, rewardRatio: cfg.rewardRatio, chopMax: cfg.chopMax, volRatioMin: cfg.volRatioMin, indicator: cfg.indicator },
  };

  console.table({
    Symbol: symbol,
    Candles: candles.length,
    Trades: summary.trades,
    'Win rate %': summary.winRate.toFixed(1),
    'Profit factor': Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : '∞',
    'Avg R': summary.avgR.toFixed(2),
    'Net PnL USDT': summary.netPnl.toFixed(2),
    'Return %': summary.returnPct.toFixed(2),
    'Max DD %': summary.maxDrawdownPct.toFixed(2),
  });
  console.log('Skipped setups:', skips);

  const outDir = path.resolve(cfg.dataDir, 'backtests');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, `${symbol}-${stamp}.json`), JSON.stringify({ summary, trades: broker.trades }, null, 2));
  const header = 'id,symbol,side,entry,exit,stop,takeProfit,contracts,margin,pnl,pnlPct,rMultiple,exitReason,openedAt,closedAt';
  const rows = broker.trades.map((t) =>
    [t.id, t.symbol, t.side, t.entry, t.exit, t.stop, t.takeProfit, t.contracts, t.margin, t.pnl, t.pnlPct, t.rMultiple, t.exitReason, new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString()].join(','),
  );
  fs.writeFileSync(path.join(outDir, `${symbol}-${stamp}.csv`), [header, ...rows].join('\n'));
  console.log(`Wrote ${path.join(outDir, `${symbol}-${stamp}.json`)} and .csv`);
}

main().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
