// Entry point: loads config, wires broker + data source + engine, serves the dashboard.
import { loadConfig, validateConfig, LIVE_CONFIRM_PHRASE, TIMEFRAME_MS } from './config.js';
import { Engine } from './engine.js';
import { PaperBroker } from './paperBroker.js';
import { LiveBroker } from './liveBroker.js';
import { MexcMarketData, SyntheticMarketData } from './marketData.js';
import { MexcPrivateClient } from './mexcApi.js';
import { JsonStore } from './store.js';
import { createServer } from './server.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function main() {
  const cfg = loadConfig();
  const problems = validateConfig(cfg);
  if (problems.length) {
    console.error('Configuration problems:\n - ' + problems.join('\n - '));
    process.exit(1);
  }

  const marketData = cfg.dataSource === 'synthetic' ? new SyntheticMarketData() : new MexcMarketData(cfg);

  let broker;
  if (cfg.mode === 'live') {
    const client = new MexcPrivateClient({
      baseUrl: cfg.mexcPrivateBase,
      apiKey: cfg.mexcApiKey,
      apiSecret: cfg.mexcApiSecret,
    });
    broker = new LiveBroker({ client, positionMode: cfg.positionMode });
    log(`LIVE MODE — real orders on MEXC (${LIVE_CONFIRM_PHRASE} confirmed).`);
  } else {
    broker = new PaperBroker({
      startBalance: cfg.startBalance,
      slippagePct: cfg.paperSlippagePct,
      leverage: cfg.leverage,
    });
    log(`PAPER MODE — simulated trading, data source: ${cfg.dataSource}.`);
  }

  const store = new JsonStore(cfg.dataDir, `${cfg.mode}-${cfg.dataSource}`);
  const engine = new Engine({ cfg, marketData, broker, store, log });

  await engine.init();

  // Demo only: on a fresh synthetic state, replay past bars so the dashboard has history.
  if (cfg.dataSource === 'synthetic' && cfg.syntheticBackfillBars > 0 && !store.load()) {
    let t = Date.now() - cfg.syntheticBackfillBars * TIMEFRAME_MS;
    engine.now = () => t;
    for (let i = 0; i < cfg.syntheticBackfillBars; i++) {
      await engine.tick();
      t += TIMEFRAME_MS;
    }
    engine.now = () => Date.now();
    log(`Backfilled ${cfg.syntheticBackfillBars} synthetic bars: ${broker.trades.length} trades.`);
  }

  const server = createServer({ getSnapshot: () => engine.snapshot() });
  server.listen(cfg.port, cfg.host, () => {
    log(`Dashboard running at http://${cfg.host}:${cfg.port}`);
  });

  const shutdown = () => {
    log('shutting down…');
    engine.stop();
    engine.persist();
    server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await engine.run();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
