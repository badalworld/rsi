// All settings come from environment variables (see .env.example).
// Defaults implement the user's rules; change them only deliberately.

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const num = (key, fallback) => {
  const v = Number(env(key, fallback));
  if (!Number.isFinite(v)) throw new Error(`Config ${key} must be a number, got "${process.env[key]}"`);
  return v;
};
const bool = (key, fallback) => {
  const v = String(env(key, fallback)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};

export const TIMEFRAME_MS = 15 * 60 * 1000; // Execution timeframe: fixed at 15 minutes by the rules.
export const TIMEFRAME_LABEL = '15m';
export const MEXC_KLINE_INTERVAL = 'Min15';
export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_LIVE_TRADING';

export function loadConfig() {
  const mode = env('MODE', 'paper').toLowerCase();
  const dataSource = env('DATA_SOURCE', 'mexc').toLowerCase();
  if (!['paper', 'live'].includes(mode)) throw new Error('MODE must be "paper" or "live"');
  if (!['mexc', 'synthetic'].includes(dataSource)) throw new Error('DATA_SOURCE must be "mexc" or "synthetic"');

  const symbols = env('SYMBOLS', 'BTC_USDT,ETH_USDT,SOL_USDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return {
    mode,
    dataSource,
    symbols,
    timeframe: TIMEFRAME_LABEL,
    port: num('PORT', 3000),
    host: env('HOST', '0.0.0.0'),
    pollSeconds: num('POLL_SECONDS', 15),
    dataDir: env('DATA_DIR', 'data'),

    // Account & sizing rules
    startBalance: num('PAPER_START_BALANCE', 1000), // paper mode only
    riskMarginPct: num('RISK_MARGIN_PCT', 8), // % of balance used as margin per trade
    leverage: num('LEVERAGE', 10),
    rewardRatio: num('REWARD_RATIO', 2), // take profit = 1:2 of the stop distance
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
    minStopPct: num('MIN_STOP_PCT', 0.1), // sanity: stop must be at least this far from entry (%)
    maxStopPct: num('MAX_STOP_PCT', 8.5), // safety: stop must be closer than the 10x liquidation zone (%)
    stopBufferPct: num('STOP_BUFFER_PCT', 0), // extra room beyond the swing point (0 = exact swing)
    staleSignalSeconds: num('STALE_SIGNAL_SECONDS', 300), // ignore a signal whose bar closed longer ago than this

    // Market regime gate (choppy / high-volatility rule)
    chopPeriod: num('CHOP_PERIOD', 14),
    chopMax: num('CHOP_MAX', 61.8),
    atrPeriod: num('ATR_PERIOD', 14),
    atrBasePeriod: num('ATR_BASE_PERIOD', 50),
    volRatioMin: num('VOL_RATIO_MIN', 1.0),

    // Mo3ty RSI indicator settings (defaults copied from the Pine script)
    indicator: {
      rsiLength: num('RSI_LENGTH', 16),
      upperLevel: num('RSI_OVERBOUGHT', 70),
      lowerLevel: num('RSI_OVERSOLD', 30),
      pivotLeft: num('PIVOT_LEFT', 5),
      pivotRight: num('PIVOT_RIGHT', 5),
      useDivergenceZoneFilter: bool('DIV_ZONE_FILTER', true),
    },

    // Paper-trading simulation
    paperSlippagePct: num('PAPER_SLIPPAGE_PCT', 0.02),
    syntheticBackfillBars: num('SYNTHETIC_BACKFILL_BARS', 0), // demo only: replay N past bars on a fresh synthetic state

    // MEXC connectivity
    mexcPublicBase: env('MEXC_PUBLIC_BASE', 'https://contract.mexc.com'),
    mexcPrivateBase: env('MEXC_PRIVATE_BASE', 'https://api.mexc.com'),
    mexcApiKey: env('MEXC_API_KEY', ''),
    mexcApiSecret: env('MEXC_API_SECRET', ''),
    positionMode: num('MEXC_POSITION_MODE', 1), // 1 = hedge (exchange default), 2 = one-way
    liveConfirm: env('LIVE_CONFIRM', ''),
  };
}

export function validateConfig(cfg) {
  const problems = [];
  if (cfg.symbols.length === 0) problems.push('SYMBOLS is empty');
  if (cfg.riskMarginPct <= 0 || cfg.riskMarginPct > 100) problems.push('RISK_MARGIN_PCT must be in (0, 100]');
  if (cfg.leverage < 1 || cfg.leverage > 125) problems.push('LEVERAGE must be between 1 and 125');
  if (cfg.rewardRatio <= 0) problems.push('REWARD_RATIO must be > 0');
  if (cfg.minStopPct >= cfg.maxStopPct) problems.push('MIN_STOP_PCT must be below MAX_STOP_PCT');
  if (cfg.mode === 'live') {
    if (!cfg.mexcApiKey || !cfg.mexcApiSecret) problems.push('live mode needs MEXC_API_KEY and MEXC_API_SECRET');
    if (cfg.liveConfirm !== LIVE_CONFIRM_PHRASE) {
      problems.push(`live mode requires LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} (explicit opt-in to real trading)`);
    }
    if (cfg.dataSource !== 'mexc') problems.push('live mode requires DATA_SOURCE=mexc');
  }
  return problems;
}
