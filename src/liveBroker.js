// Live broker for MEXC USDT-M futures. Same interface as PaperBroker.
//
//  open()       places a MARKET order (isolated, LEVERAGE x) with the stop-loss and
//               take-profit attached, so protection lives on the exchange.
//  beginTick()  refreshes wallet + positions, matches pending orders to fills, and
//               records trades whose positions have closed (via history_positions).
//  Positions that were not opened by this bot are shown as EXTERNAL and still block
//  a new entry on the same symbol.
//
// NOTE: this code path talks to the real exchange. Run it on paper first.

const PENDING_TIMEOUT_MS = 90_000;

export class LiveBroker {
  constructor({ client, positionMode = 1, source = 'live' }) {
    this.client = client;
    this.positionMode = positionMode;
    this.source = source;
    this.tracked = []; // bot-opened positions/orders
    this.trades = [];
    this.marks = {};
    this.exPositions = []; // raw-ish positions from the exchange
    this.acc = { balance: 0, equity: 0, available: 0, unrealized: 0, marginUsed: 0 };
    this.lastSyncAt = null;
    this.events = []; // broker-level notices surfaced to the dashboard
    this.nextId = 1;
  }

  note(msg) {
    this.events.push({ t: Date.now(), msg });
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
  }

  async beginTick(nowMs = Date.now()) {
    const asset = await this.client.getAsset('USDT');
    const equity = Number(asset.equity);
    const unrealized = Number(asset.unrealized ?? 0);
    this.acc = {
      balance: equity - unrealized,
      equity,
      available: Number(asset.availableBalance),
      unrealized,
      marginUsed: Number(asset.positionMargin ?? 0),
    };

    const raw = await this.client.getOpenPositions();
    this.exPositions = raw
      .filter((p) => p.state === 1 || p.state === 2)
      .map((p) => ({
        positionId: p.positionId,
        symbol: p.symbol,
        side: Number(p.positionType) === 1 ? 'LONG' : 'SHORT',
        contracts: Number(p.holdVol),
        entry: Number(p.holdAvgPrice),
        liqPrice: Number(p.liquidatePrice),
        margin: Number(p.im ?? p.oim ?? 0),
        leverage: Number(p.leverage),
        unrealized: Number(p.unRealizedPnl ?? p.unrealized ?? 0),
      }));
    this.acc.marginUsed = this.exPositions.reduce((s, p) => s + p.margin, 0) || this.acc.marginUsed;

    // 1) Match pending orders to exchange positions.
    const claimed = new Set();
    for (const t of this.tracked.filter((x) => x.status === 'PENDING')) {
      const match = this.exPositions.find(
        (p) => p.symbol === t.symbol && p.side === t.side && !claimed.has(p.positionId),
      );
      if (match) {
        claimed.add(match.positionId);
        t.status = 'OPEN';
        t.positionId = match.positionId;
        t.entry = match.entry || t.entry;
        t.liqPrice = match.liqPrice;
        this.note(`${t.symbol} ${t.side} filled @ ${t.entry}`);
      } else if (nowMs - t.submittedAt > PENDING_TIMEOUT_MS) {
        t.status = 'FAILED';
        this.note(`${t.symbol} ${t.side} order never appeared as a position (order ${t.orderId})`);
      }
    }
    this.tracked = this.tracked.filter((t) => t.status !== 'FAILED');

    // 2) Detect closed positions and record them.
    for (const t of this.tracked.filter((x) => x.status === 'OPEN')) {
      if (this.exPositions.some((p) => p.positionId === t.positionId)) continue;
      const history = await this.client.getHistoryPositions(t.symbol);
      const h = history.find((x) => String(x.positionId) === String(t.positionId)) || history[0];
      const pnl = h ? Number(h.realised ?? h.closeProfitLoss ?? 0) : 0;
      const exit = h ? Number(h.closeAvgPrice || h.newCloseAvgPrice) : NaN;
      const fees = h ? Number(h.totalFee ?? h.fee ?? 0) : 0;
      let reason = 'CLOSED';
      if (Number.isFinite(exit)) {
        if (t.side === 'LONG') {
          if (exit <= t.stop * 1.002) reason = 'STOP_LOSS';
          else if (exit >= t.takeProfit * 0.998) reason = 'TAKE_PROFIT';
        } else {
          if (exit >= t.stop * 0.998) reason = 'STOP_LOSS';
          else if (exit <= t.takeProfit * 1.002) reason = 'TAKE_PROFIT';
        }
      }
      const risk = Math.abs(t.entry - t.stop) * t.qty;
      const trade = {
        id: t.id,
        source: this.source,
        symbol: t.symbol,
        side: t.side,
        divergence: t.divergence,
        entry: t.entry,
        exit: Number.isFinite(exit) ? exit : null,
        stop: t.stop,
        takeProfit: t.takeProfit,
        contracts: t.contracts,
        qty: t.qty,
        leverage: t.leverage,
        margin: t.margin,
        fees,
        pnl,
        pnlPct: t.margin ? (pnl / t.margin) * 100 : 0,
        rMultiple: risk > 0 ? pnl / risk : 0,
        exitReason: reason,
        openedAt: t.openedAt,
        closedAt: nowMs,
        regime: t.regime,
      };
      this.trades.push(trade);
      if (this.trades.length > 1000) this.trades.splice(0, this.trades.length - 1000);
      this.note(`${t.symbol} ${t.side} closed (${reason}) PnL ${pnl.toFixed(4)} USDT`);
      t.status = 'CLOSED';
    }
    this.tracked = this.tracked.filter((t) => t.status !== 'CLOSED');
    this.lastSyncAt = nowMs;
  }

  account() {
    return { ...this.acc };
  }

  markPrice(symbol, price) {
    if (Number.isFinite(price)) this.marks[symbol] = price;
  }

  manage() {
    return []; // exits are handled by exchange-side stop/take-profit; closures are detected in beginTick()
  }

  openPositions() {
    const botOwned = this.tracked
      .filter((t) => t.status === 'OPEN' || t.status === 'PENDING')
      .map((t) => {
        const mark = this.marks[t.symbol] ?? t.entry;
        const dir = t.side === 'LONG' ? 1 : -1;
        const ex = this.exPositions.find((p) => p.positionId === t.positionId);
        return {
          id: t.id,
          source: this.source,
          symbol: t.symbol,
          side: t.side,
          divergence: t.divergence,
          status: t.status,
          entry: t.entry,
          stop: t.stop,
          takeProfit: t.takeProfit,
          contracts: t.contracts,
          qty: t.qty,
          leverage: t.leverage,
          margin: t.margin,
          liqPrice: ex?.liqPrice ?? t.liqPrice ?? null,
          openedAt: t.openedAt,
          regime: t.regime,
          unrealized: ex ? ex.unrealized : (mark - t.entry) * t.qty * dir,
          external: false,
        };
      });
    const claimedIds = new Set(this.tracked.map((t) => t.positionId).filter(Boolean));
    const external = this.exPositions
      .filter((p) => !claimedIds.has(p.positionId))
      .map((p) => ({
        id: `EXT-${p.positionId}`,
        source: this.source,
        symbol: p.symbol,
        side: p.side,
        divergence: null,
        status: 'EXTERNAL',
        entry: p.entry,
        stop: null,
        takeProfit: null,
        contracts: p.contracts,
        qty: null,
        leverage: p.leverage,
        margin: p.margin,
        liqPrice: p.liqPrice,
        openedAt: null,
        regime: null,
        unrealized: p.unrealized,
        external: true,
      }));
    return [...botOwned, ...external];
  }

  async open(plan, nowMs = Date.now()) {
    if (this.tracked.some((t) => t.symbol === plan.symbol) || this.exPositions.some((p) => p.symbol === plan.symbol)) {
      throw new Error(`position already open on ${plan.symbol}`);
    }
    const id = `L${this.nextId++}`;
    const externalOid = `mo3ty${id}${nowMs}`.slice(0, 32);
    const data = await this.client.placeMarketOpen({
      symbol: plan.symbol,
      side: plan.side === 'LONG' ? 1 : 3,
      vol: plan.contracts,
      leverage: plan.leverage,
      price: plan.entry,
      stopLossPrice: plan.stop,
      takeProfitPrice: plan.takeProfit,
      positionMode: this.positionMode,
      externalOid,
    });
    const t = {
      id,
      symbol: plan.symbol,
      side: plan.side,
      divergence: plan.divergence,
      entry: plan.entry,
      stop: plan.stop,
      takeProfit: plan.takeProfit,
      contracts: plan.contracts,
      qty: plan.qty,
      leverage: plan.leverage,
      margin: plan.margin,
      regime: plan.regime,
      orderId: data?.orderId ?? null,
      status: 'PENDING',
      submittedAt: nowMs,
      openedAt: nowMs,
      positionId: null,
    };
    this.tracked.push(t);
    this.note(`${plan.symbol} ${plan.side} market order submitted (${t.orderId})`);
    return t;
  }

  snapshot() {
    return { source: this.source, tracked: this.tracked, trades: this.trades, nextId: this.nextId, marks: this.marks };
  }

  restore(state) {
    if (!state) return;
    this.tracked = state.tracked || [];
    this.trades = state.trades || [];
    this.nextId = state.nextId || 1;
    this.marks = state.marks || {};
  }
}
