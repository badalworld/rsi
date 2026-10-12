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
    pnl: computePnlAnalytics(trades, now),
    trades: trades.slice(-150).reverse(),
    signals: st.signals.slice(-150).reverse(),
    equity: st.equityCurve.slice(-600),
    symbols,
    events: (broker.events || []).slice(-30).reverse(),
  };
}

// PnL analytics for the dashboard, computed from closed trades only.
export function computePnlAnalytics(trades, now, days = 30) {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);

  let cum = 0;
  const cumulative = sorted.map((t) => {
    cum += t.pnl;
    return { t: t.closedAt, pnl: t.pnl, cum, symbol: t.symbol };
  });

  // Daily realised PnL (UTC) for the last `days` days, oldest first.
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const dayMap = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    dayMap.set(d.toISOString().slice(0, 10), { day: d.toISOString().slice(0, 10), pnl: 0, trades: 0, wins: 0 });
  }
  for (const t of sorted) {
    const key = new Date(t.closedAt).toISOString().slice(0, 10);
    const row = dayMap.get(key);
    if (row) {
      row.pnl += t.pnl;
      row.trades++;
      if (t.pnl > 0) row.wins++;
    }
  }
  const daily = [...dayMap.values()];

  // By symbol
  const symMap = new Map();
  for (const t of sorted) {
    if (!symMap.has(t.symbol)) symMap.set(t.symbol, { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 });
    const r = symMap.get(t.symbol);
    r.pnl += t.pnl;
    r.trades++;
    if (t.pnl > 0) r.wins++;
  }
  const bySymbol = [...symMap.values()].sort((a, b) => b.pnl - a.pnl);

  // By side
  const bySide = ['LONG', 'SHORT'].map((side) => {
    const ts = sorted.filter((t) => t.side === side);
    return { side, pnl: ts.reduce((s, t) => s + t.pnl, 0), trades: ts.length, wins: ts.filter((t) => t.pnl > 0).length };
  });

  // R-multiple distribution
  const bins = [
    { label: '≤ -2R', min: -Infinity, max: -2 },
    { label: '-2 … -1R', min: -2, max: -1 },
    { label: '-1 … 0R', min: -1, max: 0 },
    { label: '0 … 1R', min: 0, max: 1 },
    { label: '1 … 2R', min: 1, max: 2 },
    { label: '2 … 3R', min: 2, max: 3 },
    { label: '≥ 3R', min: 3, max: Infinity },
  ];
  const rHist = bins.map((b) => ({
    label: b.label,
    count: sorted.filter((t) => t.rMultiple > b.min && t.rMultiple <= b.max).length,
  }));

  // Exit reasons
  const exitReasons = {};
  for (const t of sorted) exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;

  const best = sorted.reduce((b, t) => (b === null || t.pnl > b.pnl ? t : b), null);
  const worst = sorted.reduce((w, t) => (w === null || t.pnl < w.pnl ? t : w), null);
  const bestDay = daily.reduce((b, d) => (b === null || d.pnl > b.pnl ? d : b), null);
  const worstDay = daily.reduce((w, d) => (w === null || d.pnl < w.pnl ? d : w), null);

  return {
    cumulative: cumulative.slice(-500),
    daily,
    bySymbol,
    bySide,
    rHist,
    exitReasons,
    bestTrade: best ? { symbol: best.symbol, pnl: best.pnl, t: best.closedAt } : null,
    worstTrade: worst ? { symbol: worst.symbol, pnl: worst.pnl, t: worst.closedAt } : null,
    bestDay: bestDay && bestDay.trades ? bestDay : null,
    worstDay: worstDay && worstDay.trades ? worstDay : null,
  };
}
