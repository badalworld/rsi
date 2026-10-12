# Mo3ty RSI · MEXC Futures Auto-Trader

An auto-trading engine for MEXC USDT-M perpetual futures that trades **only** the
Mo3ty RSI Signals & Divergence indicator (bull/bear divergence), on **15-minute
closed candles**, with a live colour dashboard.

No external dependencies: Node.js ≥ 22 only.

```bash
cp .env.example .env        # defaults already implement the rules
npm test                    # 33 unit + integration tests
npm start                   # paper trading on real MEXC candles → http://localhost:3000
npm run backtest -- --symbol BTC_USDT --bars 3000
```

Demo without internet access (generated candles, clearly labelled on the dashboard):

```bash
DATA_SOURCE=synthetic SYNTHETIC_BACKFILL_BARS=1500 npm start
```

## Trading rules → implementation

| Your rule | Implementation |
|---|---|
| Buy on bull divergence | `src/mo3ty.js` ports the Pine divergence logic bar-for-bar (pivot low on 5/5 bars, RSI(16) higher-low vs price lower-low, oversold zone filter as in the script). A confirmed bull divergence on a closed 15m bar opens a **LONG** at that bar's close. |
| Sell on bear divergence | Mirror logic on pivot highs, overbought zone; opens a **SHORT**. |
| TP 1:2 | Take profit = entry ± 2 × |entry − stop|. Attached to the exchange order. |
| SL at recent swing low/high | Stop = the divergence's swing pivot price (low for longs, high for shorts). `STOP_BUFFER_PCT` defaults to 0. |
| 8% of balance, 10x | Margin = 8% of equity; notional = 10 × margin (isolated margin). |
| No extra filters | The only entry trigger is the Mo3ty divergence. EMA, MACD, and candle-direction filters from the Pine script are not used. |
| Trade only high-volatility markets; never choppy | Regime gate (`src/regime.js`): **CHOPPY** if Choppiness Index(14) > 61.8; **LOW_VOL** if ATR(14) < its 50-bar average. Both longs and shorts are allowed when the market is tradable. |
| 15-minute execution | Only closed 15m candles are evaluated; each signal bar is processed once. |
| Colourful dashboard | `public/` — live KPIs, candlestick + RSI chart with divergence markers, SL/TP lines, regime meters, equity curve, positions, trades, signal log, events. |

### Safety guards (not signal filters — please review)

These are my additions to keep the rules executable safely. Each is configurable and can be relaxed:

- **Stale signal** — a divergence whose bar closed more than 5 min ago is logged as skipped (`STALE_SIGNAL_SECONDS`).
- **Stop distance** — must be between 0.1% and 8.5% from entry (`MIN_STOP_PCT`, `MAX_STOP_PCT`). The upper cap keeps the stop inside the 10x liquidation zone.
- **One position per symbol**, and at most **3 open positions** in total (`MAX_OPEN_POSITIONS`).
- **Exchange minimum size** — trades below the contract minimum are skipped.
- **Conflicting bull and bear on the same bar** — skipped.

## Interpretations to confirm

1. "8% per trade with 10x" = **8% of balance as margin**, so the notional is 80% of balance. If you meant an 8% *risk* (loss) per trade, the sizing function in `src/strategy.js` needs changing.
2. "Recent swing low/high" = the pivot that formed the divergence (5 bars before the signal).
3. "Choppy zone" = Choppiness Index above 61.8 (the standard threshold). "High volatility" = ATR(14) at or above its 50-bar average.
4. Entry is a market order at the signal bar's close.

## Modes

| `MODE` | What happens |
|---|---|
| `paper` (default) | Simulated fills (slippage + taker fees) against real MEXC candles. Persists to `data/state-paper-mexc.json`. |
| `live` | Places **real** market orders with stop-loss and take-profit attached on MEXC. Requires `MEXC_API_KEY`, `MEXC_API_SECRET`, and `LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING`. |

API keys are read from environment variables only. They are never written to disk or sent to the dashboard. Create the key with **futures trading** permission and **IP binding** enabled, and withdrawal permission **off**.

## Live-mode notes (read before enabling)

- The live path follows the official MEXC Futures API (signing, `/api/v1/private/order/create` with `stopLossPrice`/`takeProfitPrice`, `/account/asset/USDT`, `/position/open_positions`, `/position/list/history_positions`). **It has not been run against the live exchange** from the build environment, which could not reach MEXC. Run paper mode for a while, then start live with a small balance.
- Exchange-side SL/TP protect open positions even if the bot is offline. Closures are recorded by reconciling against exchange history on each poll, and the exit reason is inferred from the close price.
- Positions opened outside the bot appear as **EXTERNAL** and still block new entries on that symbol.
- Hedge mode (`MEXC_POSITION_MODE=1`) is the exchange default; set `2` if your account uses one-way mode.

## Backtesting

`npm run backtest` replays the same divergence, regime, sizing, and broker code over historical MEXC candles. It writes JSON and CSV to `data/backtests/`. Results depend on the period tested. A backtest does not prove future performance.

## Layout

```
src/
  config.js        env-driven settings & validation
  indicators.js    RSI (Wilder RMA), ATR, Choppiness, pivots
  mo3ty.js         Mo3ty RSI divergence (Pine port)
  regime.js        choppy / low-volatility gate
  strategy.js      entry decision, SL/TP, sizing
  paperBroker.js   simulated broker (fees, slippage, SL/TP, liquidation)
  liveBroker.js    MEXC broker (orders, reconciliation)
  mexcApi.js       MEXC REST client + HMAC signing
  marketData.js    MEXC candles / synthetic feed
  engine.js        poll loop, signal processing, persistence
  snapshot.js      dashboard JSON
  server.js        read-only dashboard server (no trading endpoints)
public/            dashboard (HTML/CSS/canvas JS, no CDN)
scripts/backtest.js
test/              node:test suites
```

The dashboard server binds to `0.0.0.0` and is read-only, but it has no authentication. Put it behind a firewall or reverse proxy if the host is reachable from the internet.

## Disclaimer

Trading with 10x leverage can lose your entire margin on each trade. This software is provided as-is, without warranty, and does not guarantee profit.
