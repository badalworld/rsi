// Builds the JSON document the dashboard polls (/api/state).
// Contains no secrets: API keys are never included.
import { TIMEFRAME_MS } from './config.js';

export function computeStats(trades, startEquity, equityCurve) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgR = n ? trades.reduce((s, t) => s + (t.rMultiple || 0), 0) / n : 0;

  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }

  // Current streak: +N consecutive wins, -N consecutive losses (newest trades first).
  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const won = trades[i].pnl > 0;
    if (streak === 0) streak = won ? 1 : -1;
    else if ((streak > 0) === won) streak += won ? 1 : -1;
    else break;
  }

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const today = trades.filter((t) => t.closedAt >= dayStart.getTime());

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? (wins.length / n) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR,
    totalPnl,
    totalReturnPct: startEquity ? ((totalPnl) / startEquity) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    bestTrade: n ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: n ? Math.min(...trades.map((t) => t.pnl)) : 0,
    streak,
    pnlToday: today.reduce((s, t) => s + t.pnl, 0),
    tradesToday: today.length,
  };
}

export function buildSnapshot({ cfg, engine, now }) {
  const broker = engine.broker;
  const acc = broker.account();
  const trades = broker.trades;
  const st = engine.state;
  const startEquity = cfg.mode === 'paper' ? cfg.startBalance : st.startEquity ?? acc.equity;
  const stats = computeStats(trades, startEquity, st.equityCurve);

  const nextCandleAt = Math.floor(now / TIMEFRAME_MS) * TIMEFRAME_MS + TIMEFRAME_MS;
  const errorState = st.lastError && now - st.lastError.t < 10 * 60 * 1000;

  const symbols = cfg.symbols.map((s) => engine.symbolViews[s] || { symbol: s, status: 'PENDING', error: 'waiting for first poll' });

  return {
    generatedAt: now,
    mode: cfg.mode,
    dataSource: cfg.dataSource,
    timeframe: cfg.timeframe,
    status: {
      state: errorState ? 'WARNING' : 'RUNNING',
      tickCount: st.tickCount,
      lastTickAt: st.lastTickAt,
      startedAt: st.startedAt,
      uptimeSec: Math.floor((now - st.startedAt) / 1000),
      pollSeconds: cfg.pollSeconds,
      nextCandleAt,
      secondsToNextCandle: Math.round((nextCandleAt - now) / 1000),
      lastSyncAt: broker.lastSyncAt ?? null,
      lastError: st.lastError,
    },
    config: {
      riskMarginPct: cfg.riskMarginPct,
      leverage: cfg.leverage,
      rewardRatio: cfg.rewardRatio,
      maxOpenPositions: cfg.maxOpenPositions,
      minStopPct: cfg.minStopPct,
      maxStopPct: cfg.maxStopPct,
      stopBufferPct: cfg.stopBufferPct,
      chopPeriod: cfg.chopPeriod,
      chopMax: cfg.chopMax,
      atrPeriod: cfg.atrPeriod,
      atrBasePeriod: cfg.atrBasePeriod,
      volRatioMin: cfg.volRatioMin,
      indicator: cfg.indicator,
      symbols: cfg.symbols,
    },
    account: {
      ...acc,
      startEquity,
      pnlTotal: acc.equity - startEquity,
      pnlTotalPct: startEquity ? ((acc.equity - startEquity) / startEquity) * 100 : 0,
    },
    stats,
    positions: broker.openPositions(),
    trades: trades.slice(-150).reverse(),
    signals: st.signals.slice(-150).reverse(),
    equity: st.equityCurve.slice(-600),
    symbols,
    events: (broker.events || []).slice(-30).reverse(),
  };
}
