// Trade decision: turns a Mo3ty divergence signal into an executable plan.
//
// Rules implemented here (and nowhere else):
//   BUY  : bull divergence confirmed on a closed 15m bar  -> open LONG
//   SELL : bear divergence confirmed on a closed 15m bar  -> open SHORT
//   STOP : recent swing low (long) / swing high (short) = the divergence pivot
//   TP   : 1:2 risk/reward from the entry
//   SIZE : RISK_MARGIN_PCT (8%) of balance as margin, LEVERAGE (10x) on top
//   REGIME: skip choppy markets and low-volatility markets only

const MMR = 0.004; // approximate maintenance margin rate used for the liquidation sanity check

export function roundToStep(value, step) {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step)) + 2));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

// Move a price outward (away from the entry) to the nearest tick so a stop is never tightened by rounding.
function roundOutward(value, step, towardHigher) {
  if (!(step > 0)) return value;
  const ticks = value / step;
  const rounded = towardHigher ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return Number((rounded * step).toFixed(12));
}

export function floorToStep(value, step) {
  if (!(step > 0)) return value;
  const ticks = Math.floor(value / step + 1e-9);
  return Number((ticks * step).toFixed(12));
}

/**
 * @param {object} args
 * @param {object} args.signal       Mo3ty divergence signal (see mo3ty.js)
 * @param {object} args.bar          closed signal candle {t,o,h,l,c}
 * @param {object} args.regime       regimeAt() result for the signal bar
 * @param {object} args.account      {equity, available}
 * @param {Array}  args.openPositions currently open positions (any symbol)
 * @param {string} args.symbol
 * @param {object} args.spec         contract spec {contractSize, volUnit, minVol, volScale, priceUnit, takerFeeRate}
 * @param {object} args.config       loadConfig() output
 * @returns {{action:'ENTER'|'SKIP', reason:string, plan?:object}}
 */
export function decideEntry({ signal, bar, regime, account, openPositions, symbol, spec, config }) {
  if (!signal) return { action: 'SKIP', reason: 'no divergence' };

  if (openPositions.some((p) => p.symbol === symbol)) {
    return { action: 'SKIP', reason: `position already open on ${symbol}` };
  }
  if (openPositions.length >= config.maxOpenPositions) {
    return { action: 'SKIP', reason: `max open positions reached (${config.maxOpenPositions})` };
  }
  if (!regime.tradable) {
    return { action: 'SKIP', reason: regime.reason };
  }

  const side = signal.type === 'BULL' ? 'LONG' : 'SHORT';
  const entry = bar.c;
  const buffer = config.stopBufferPct / 100;
  const rawStop = side === 'LONG' ? signal.swingPrice * (1 - buffer) : signal.swingPrice * (1 + buffer);
  const stop = roundOutward(rawStop, spec.priceUnit, side === 'SHORT');

  if (side === 'LONG' ? stop >= entry : stop <= entry) {
    return { action: 'SKIP', reason: 'price already beyond the swing stop' };
  }

  const stopDistance = Math.abs(entry - stop);
  const stopPct = (stopDistance / entry) * 100;
  if (stopPct < config.minStopPct) {
    return { action: 'SKIP', reason: `stop too tight (${stopPct.toFixed(3)}% < ${config.minStopPct}%)` };
  }
  if (stopPct > config.maxStopPct) {
    return {
      action: 'SKIP',
      reason: `stop too far (${stopPct.toFixed(2)}% > ${config.maxStopPct}% safety cap for ${config.leverage}x)`,
    };
  }

  const tpRaw = side === 'LONG' ? entry + config.rewardRatio * stopDistance : entry - config.rewardRatio * stopDistance;
  const takeProfit = roundToStep(tpRaw, spec.priceUnit);

  // Liquidation sanity: the stop must be hit before the isolated-margin liquidation price.
  const liqPrice = side === 'LONG'
    ? entry * (1 - 1 / config.leverage + MMR)
    : entry * (1 + 1 / config.leverage - MMR);
  if (side === 'LONG' ? stop <= liqPrice : stop >= liqPrice) {
    return { action: 'SKIP', reason: 'stop would sit beyond liquidation price' };
  }

  // Sizing: margin = RISK_MARGIN_PCT of balance; notional = margin * leverage.
  const targetMargin = account.equity * (config.riskMarginPct / 100);
  if (targetMargin > account.available) {
    return { action: 'SKIP', reason: `insufficient available margin (${account.available.toFixed(2)} < ${targetMargin.toFixed(2)})` };
  }
  const targetNotional = targetMargin * config.leverage;
  const baseQty = targetNotional / entry;
  const contractsRaw = baseQty / spec.contractSize;
  const contracts = floorToStep(contractsRaw, spec.volUnit || 1);
  if (contracts < spec.minVol) {
    return { action: 'SKIP', reason: `position size ${contracts} below exchange minimum ${spec.minVol} contracts` };
  }
  const qty = contracts * spec.contractSize;
  const notional = qty * entry;
  const margin = notional / config.leverage;

  return {
    action: 'ENTER',
    reason: `${signal.type === 'BULL' ? 'bull' : 'bear'} divergence on ${regime.status.toLowerCase()} market`,
    plan: {
      symbol,
      side,
      divergence: signal.type,
      entry,
      stop,
      takeProfit,
      rr: config.rewardRatio,
      stopPct,
      riskPerUnit: stopDistance,
      contracts,
      qty,
      notional,
      margin,
      leverage: config.leverage,
      liqPrice,
      signalTime: bar.t,
      swingTime: signal.swingTime,
      swingPrice: signal.swingPrice,
      rsi: signal.rsi,
      prevRsi: signal.prevRsi,
      chop: regime.chop,
      volRatio: regime.volRatio,
      regime: regime.status,
      feeRate: spec.takerFeeRate,
    },
  };
}
