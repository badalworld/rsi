// Paper broker: simulates MEXC USDT-margined perpetual positions against real
// (or synthetic) candles. Same interface as the live broker so the engine is
// identical in both modes.
//
// Conventions
//   - Entry fills at the signal candle close, adjusted by PAPER_SLIPPAGE_PCT against you.
//   - Exits are checked on each newly CLOSED candle, after entry. If one candle
//     touches both stop and target, the stop is assumed first (conservative).
//   - Gapped stops/targets fill at the candle open.
//   - Taker fee is charged on entry and exit notional.
//   - Isolated margin: a candle that reaches the liquidation price closes the
//     position for a loss equal to its margin.

const MMR = 0.004;

export class PaperBroker {
  constructor({ startBalance, slippagePct = 0.02, leverage = 10, source = 'paper' }) {
    this.source = source;
    this.startBalance = startBalance;
    this.balance = startBalance; // realised wallet balance (fees & PnL applied)
    this.slippagePct = slippagePct;
    this.leverage = leverage;
    this.positions = []; // open positions
    this.trades = []; // closed trades, newest last
    this.marks = {}; // symbol -> last price
    this.nextId = 1;
  }

  async beginTick() {
    // Nothing to sync: paper state is fully local.
  }

  marginUsed() {
    return this.positions.reduce((s, p) => s + p.margin, 0);
  }

  unrealized() {
    return this.positions.reduce((s, p) => s + this.pnlOf(p, this.marks[p.symbol] ?? p.entry), 0);
  }

  account() {
    const unrealized = this.unrealized();
    const marginUsed = this.marginUsed();
    const equity = this.balance + unrealized;
    return {
      balance: this.balance,
      equity,
      available: Math.max(0, this.balance - marginUsed),
      unrealized,
      marginUsed,
    };
  }

  pnlOf(pos, price) {
    const dir = pos.side === 'LONG' ? 1 : -1;
    return (price - pos.entry) * pos.qty * dir;
  }

  markPrice(symbol, price) {
    if (Number.isFinite(price)) this.marks[symbol] = price;
  }

  openPositions() {
    return this.positions.map((p) => ({ ...p, unrealized: this.pnlOf(p, this.marks[p.symbol] ?? p.entry) }));
  }

  /** Open a position from a decideEntry() plan. Entry fills at the signal close plus slippage. */
  open(plan, nowMs) {
    const slip = this.slippagePct / 100;
    const fill = plan.side === 'LONG' ? plan.entry * (1 + slip) : plan.entry * (1 - slip);
    const notional = plan.qty * fill;
    const entryFee = notional * plan.feeRate;
    const liq = plan.side === 'LONG'
      ? fill * (1 - 1 / plan.leverage + MMR)
      : fill * (1 + 1 / plan.leverage - MMR);
    const margin = notional / plan.leverage;
    const pos = {
      id: `P${this.nextId++}`,
      source: this.source,
      symbol: plan.symbol,
      side: plan.side,
      divergence: plan.divergence,
      entry: fill,
      plannedEntry: plan.entry,
      stop: plan.stop,
      takeProfit: plan.takeProfit,
      rr: plan.rr,
      stopPct: plan.stopPct,
      contracts: plan.contracts,
      qty: plan.qty,
      leverage: plan.leverage,
      margin,
      liqPrice: liq,
      entryFee,
      feeRate: plan.feeRate,
      initialRisk: Math.abs(fill - plan.stop) * plan.qty,
      openedAt: nowMs,
      lastBarT: plan.signalTime, // exits are evaluated on candles that open after this bar
      regime: plan.regime,
      chop: plan.chop,
      volRatio: plan.volRatio,
      swingTime: plan.swingTime,
      signalTime: plan.signalTime,
    };
    this.balance -= entryFee;
    this.positions.push(pos);
    this.marks[plan.symbol] = fill;
    return pos;
  }

  /**
   * Walk newly closed candles for a symbol and close any position whose stop,
   * target, or liquidation level is reached.
   * @param {string} symbol
   * @param {Array<{t,o,h,l,c}>} closedBars oldest first, only closed candles
   * @returns {object[]} trades closed during this call
   */
  manage(symbol, closedBars, nowMs) {
    const closed = [];
    for (const pos of this.positions.filter((p) => p.symbol === symbol)) {
      for (const bar of closedBars) {
        if (bar.t <= pos.lastBarT) continue;
        pos.lastBarT = bar.t;
        const exit = this.checkExit(pos, bar);
        if (exit) {
          closed.push(this.close(pos, exit.price, exit.reason, bar.t + 15 * 60 * 1000));
          break;
        }
      }
    }
    return closed;
  }

  checkExit(pos, bar) {
    const slip = this.slippagePct / 100;
    if (pos.side === 'LONG') {
      if (bar.l <= pos.stop) {
        const px = bar.o <= pos.stop ? bar.o : pos.stop * (1 - slip);
        return { price: px, reason: 'STOP_LOSS' };
      }
      if (bar.h >= pos.takeProfit) {
        const px = bar.o >= pos.takeProfit ? bar.o : pos.takeProfit;
        return { price: px, reason: 'TAKE_PROFIT' };
      }
      if (bar.l <= pos.liqPrice) return { price: pos.liqPrice, reason: 'LIQUIDATED' };
    } else {
      if (bar.h >= pos.stop) {
        const px = bar.o >= pos.stop ? bar.o : pos.stop * (1 + slip);
        return { price: px, reason: 'STOP_LOSS' };
      }
      if (bar.l <= pos.takeProfit) {
        const px = bar.o <= pos.takeProfit ? bar.o : pos.takeProfit;
        return { price: px, reason: 'TAKE_PROFIT' };
      }
      if (bar.h >= pos.liqPrice) return { price: pos.liqPrice, reason: 'LIQUIDATED' };
    }
    return null;
  }

  close(pos, exitPrice, reason, closedAt) {
    // Entry fee was already debited from the balance at fill time.
    const liquidated = reason === 'LIQUIDATED';
    const gross = liquidated ? -pos.margin : this.pnlOf(pos, exitPrice);
    const exitFee = liquidated ? 0 : pos.qty * exitPrice * pos.feeRate;
    const pnl = gross - exitFee - pos.entryFee; // net of both taker fees
    this.balance += gross - exitFee;
    this.positions = this.positions.filter((p) => p.id !== pos.id);
    const trade = {
      id: pos.id,
      source: pos.source,
      symbol: pos.symbol,
      side: pos.side,
      divergence: pos.divergence,
      entry: pos.entry,
      exit: exitPrice,
      stop: pos.stop,
      takeProfit: pos.takeProfit,
      contracts: pos.contracts,
      qty: pos.qty,
      leverage: pos.leverage,
      margin: pos.margin,
      fees: pos.entryFee + exitFee,
      pnl,
      pnlPct: (pnl / pos.margin) * 100,
      rMultiple: pos.initialRisk > 0 ? pnl / pos.initialRisk : 0,
      exitReason: reason,
      openedAt: pos.openedAt,
      closedAt,
      regime: pos.regime,
    };
    this.trades.push(trade);
    if (this.trades.length > 1000) this.trades.splice(0, this.trades.length - 1000);
    return trade;
  }

  snapshot() {
    return {
      source: this.source,
      startBalance: this.startBalance,
      balance: this.balance,
      positions: this.positions,
      trades: this.trades,
      marks: this.marks,
      nextId: this.nextId,
    };
  }

  restore(state) {
    if (!state) return;
    this.balance = state.balance;
    this.positions = state.positions || [];
    this.trades = state.trades || [];
    this.marks = state.marks || {};
    this.nextId = state.nextId || this.nextId;
  }
}
