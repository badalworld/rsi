// Trading engine: every poll it looks at the latest CLOSED 15m candle of every
// symbol, runs the Mo3ty divergence + regime gate, and executes through the broker.
//
// Each signal bar is processed exactly once (state.lastBarT). Signals whose bar
// closed longer ago than STALE_SIGNAL_SECONDS are recorded as skipped, never executed.
import { computeMo3ty } from './mo3ty.js';
import { computeRegime, regimeAt } from './regime.js';
import { decideEntry } from './strategy.js';
import { TIMEFRAME_MS } from './config.js';
import { buildSnapshot } from './snapshot.js';

const CANDLE_HISTORY = 600; // bars fetched per symbol per poll (>= 500 for stable RSI/CHOP warm-up)
const MAX_SIGNALS = 300;
const MAX_EQUITY_POINTS = 2000;

export class Engine {
  constructor({ cfg, marketData, broker, store, log = console.log, now = () => Date.now() }) {
    this.cfg = cfg;
    this.marketData = marketData;
    this.broker = broker;
    this.store = store;
    this.log = log;
    this.now = now;
    this.specs = {};
    this.symbolErrors = {};
    this.symbolViews = {};
    this.state = {
      startedAt: now(),
      tickCount: 0,
      lastTickAt: null,
      lastError: null,
      lastBarT: {},
      signals: [],
      equityCurve: [],
      startEquity: null,
      nextSignalId: 1,
    };
    this.running = false;
  }

  async init() {
    const saved = this.store.load();
    if (saved) {
      this.state = { ...this.state, ...saved.state };
      this.broker.restore(saved.broker);
      this.log(`[engine] restored state: ${this.broker.trades.length} trades, ${this.broker.openPositions().length} open positions`);
    }
    for (const symbol of this.cfg.symbols) {
      await this.ensureSpec(symbol);
    }
  }

  // Contract specs are retried every poll until they load, so a transient network error never disables a symbol.
  async ensureSpec(symbol) {
    if (this.specs[symbol]) return true;
    try {
      const spec = await this.marketData.spec(symbol);
      this.specs[symbol] = spec;
      delete this.symbolErrors[symbol];
      if (spec.apiAllowed === false) {
        this.symbolErrors[symbol] = 'API trading not allowed for this contract';
        return false;
      }
      return true;
    } catch (err) {
      this.symbolErrors[symbol] = `contract spec unavailable: ${err.message}`;
      return false;
    }
  }

  recordSignal(evt) {
    const entry = { id: this.state.nextSignalId++, ...evt };
    this.state.signals.push(entry);
    if (this.state.signals.length > MAX_SIGNALS) this.state.signals.splice(0, this.state.signals.length - MAX_SIGNALS);
    this.log(`[signal] ${evt.symbol} ${evt.type} ${evt.action}: ${evt.reason}`);
    return entry;
  }

  recordError(msg) {
    this.state.lastError = { t: this.now(), msg };
    this.log(`[error] ${msg}`);
  }

  async tick() {
    const now = this.now();
    this.state.tickCount++;
    this.state.lastTickAt = now;

    try {
      await this.broker.beginTick(now);
    } catch (err) {
      this.recordError(`account sync failed: ${err.message}`);
      this.persist();
      return;
    }

    for (const symbol of this.cfg.symbols) {
      if (!this.specs[symbol]) await this.ensureSpec(symbol);
      if (this.symbolErrors[symbol]) {
        this.symbolViews[symbol] = { symbol, status: 'ERROR', error: this.symbolErrors[symbol] };
        continue;
      }
      try {
        await this.processSymbol(symbol, now);
      } catch (err) {
        this.symbolViews[symbol] = { symbol, status: 'ERROR', error: err.message };
        this.recordError(`${symbol}: ${err.message}`);
      }
    }

    this.recordEquity(now);
    this.persist();
  }

  async processSymbol(symbol, now) {
    const bars = await this.marketData.candles(symbol, CANDLE_HISTORY, now);
    if (bars.length === 0) throw new Error('no candles returned');
    const lastPrice = bars[bars.length - 1].c;
    this.broker.markPrice(symbol, lastPrice);

    const closed = bars.filter((b) => b.t + TIMEFRAME_MS <= now);
    if (closed.length < 60) throw new Error(`only ${closed.length} closed candles, need more history`);

    // Exits for paper positions are evaluated on newly closed candles.
    const closedTrades = this.broker.manage(symbol, closed, now);
    for (const tr of closedTrades) {
      this.log(`[trade] ${symbol} ${tr.side} closed ${tr.exitReason} pnl ${tr.pnl.toFixed(4)} USDT`);
    }

    const ind = computeMo3ty(closed, this.cfg.indicator);
    const reg = computeRegime(closed, this.cfg);
    const idx = closed.length - 1;
    const bar = closed[idx];

    this.symbolViews[symbol] = this.buildSymbolView(symbol, bars, closed, ind, reg, lastPrice);

    const processedT = this.state.lastBarT[symbol];
    if (processedT !== undefined && bar.t <= processedT) return;
    this.state.lastBarT[symbol] = bar.t;

    const signals = ind.signalsAt.get(idx) || [];
    if (signals.length === 0) return;

    const regime = regimeAt(reg, idx);
    const ageSec = (now - (bar.t + TIMEFRAME_MS)) / 1000;
    for (const signal of signals) {
      const base = {
        symbol,
        type: signal.type,
        barT: bar.t,
        price: bar.c,
        swingPrice: signal.swingPrice,
        swingTime: signal.swingTime,
        rsi: signal.rsi,
        prevRsi: signal.prevRsi,
        chop: regime.chop,
        volRatio: regime.volRatio,
        regime: regime.status,
        t: now,
      };
      if (signals.length > 1) {
        this.recordSignal({ ...base, action: 'SKIPPED', reason: 'conflicting bull and bear divergence on the same bar' });
        continue;
      }
      if (ageSec > this.cfg.staleSignalSeconds) {
        this.recordSignal({ ...base, action: 'SKIPPED', reason: `stale signal (bar closed ${Math.round(ageSec)}s ago)` });
        continue;
      }
      if (!this.specs[symbol]) {
        this.recordSignal({ ...base, action: 'SKIPPED', reason: 'contract spec unavailable' });
        continue;
      }

      const decision = decideEntry({
        signal,
        bar,
        regime,
        account: this.broker.account(),
        openPositions: this.broker.openPositions(),
        symbol,
        spec: this.specs[symbol],
        config: this.cfg,
      });

      if (decision.action !== 'ENTER') {
        this.recordSignal({ ...base, action: 'SKIPPED', reason: decision.reason });
        continue;
      }

      try {
        const plan = decision.plan;
        await this.broker.open(plan, now);
        this.recordSignal({
          ...base,
          action: 'EXECUTED',
          reason: `${plan.side} ${plan.contracts} contracts @ ${plan.entry} | SL ${plan.stop} | TP ${plan.takeProfit} | margin ${plan.margin.toFixed(2)} USDT`,
          side: plan.side,
          stop: plan.stop,
          takeProfit: plan.takeProfit,
          margin: plan.margin,
          contracts: plan.contracts,
        });
      } catch (err) {
        this.recordSignal({ ...base, action: 'FAILED', reason: `order failed: ${err.message}` });
      }
    }
  }

  buildSymbolView(symbol, bars, closed, ind, reg, lastPrice) {
    const HIST = 120;
    const offset = Math.max(0, closed.length - HIST);
    const candles = closed.slice(offset);
    const last = closed.length - 1;
    const day = bars[Math.max(0, bars.length - 97)];
    const change24h = day ? ((lastPrice / day.c) - 1) * 100 : null;
    const marks = [];
    for (let i = offset; i < closed.length; i++) {
      for (const s of ind.signalsAt.get(i) || []) {
        marks.push({
          index: i - offset,
          type: s.type,
          time: s.time,
          price: s.type === 'BULL' ? closed[i].l : closed[i].h,
          swingTime: s.swingTime,
          swingPrice: s.swingPrice,
          swingIndex: s.swingIndex - offset,
          rsi: s.rsi,
          prevSwingIndex: Number.isFinite(s.prevSwingIndex) ? s.prevSwingIndex - offset : null,
          prevSwingPrice: Number.isFinite(s.prevSwingPrice) ? s.prevSwingPrice : null,
          prevRsi: Number.isFinite(s.prevRsi) ? s.prevRsi : null,
        });
      }
    }
    const regNow = regimeAt(reg, last);
    return {
      symbol,
      status: 'OK',
      price: lastPrice,
      change24h,
      lastBarT: closed[last].t,
      rsi: ind.rsi[last],
      regime: regNow,
      candles,
      rsiSeries: ind.rsi.slice(offset),
      chopSeries: reg.chop.slice(offset),
      volSeries: reg.volRatio.slice(offset),
      marks,
      spec: this.specs[symbol]
        ? { contractSize: this.specs[symbol].contractSize, priceUnit: this.specs[symbol].priceUnit, minVol: this.specs[symbol].minVol }
        : null,
    };
  }

  recordEquity(now) {
    const acc = this.broker.account();
    if (this.state.startEquity === null || this.state.startEquity === undefined) {
      this.state.startEquity = acc.equity;
    }
    const last = this.state.equityCurve[this.state.equityCurve.length - 1];
    if (!last || Math.abs(last.equity - acc.equity) > 1e-9 || now - last.t > 5 * 60 * 1000) {
      this.state.equityCurve.push({ t: now, equity: acc.equity });
      if (this.state.equityCurve.length > MAX_EQUITY_POINTS) {
        this.state.equityCurve.splice(0, this.state.equityCurve.length - MAX_EQUITY_POINTS);
      }
    }
  }

  persist() {
    try {
      this.store.save({ version: 1, savedAt: this.now(), state: this.state, broker: this.broker.snapshot() });
    } catch (err) {
      this.recordError(`persist failed: ${err.message}`);
    }
  }

  snapshot() {
    return buildSnapshot({ cfg: this.cfg, engine: this, now: this.now() });
  }

  async run() {
    this.running = true;
    while (this.running) {
      await this.tick();
      await new Promise((r) => setTimeout(r, this.cfg.pollSeconds * 1000));
    }
  }

  stop() {
    this.running = false;
  }
}
