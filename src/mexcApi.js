// MEXC USDT-M futures REST client (public market data + signed private trading).
// Signing follows the official Futures integration guide:
//   GET/DELETE: sorted query string;  POST: the exact JSON body string
//   signature = HMAC_SHA256(secret, accessKey + requestTime + paramString), hex
import crypto from 'node:crypto';
import { MEXC_KLINE_INTERVAL, TIMEFRAME_MS } from './config.js';

const TIMEOUT_MS = 12000;

async function parseJson(res, label) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label}: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || body.success === false) {
    throw new Error(`${label}: ${body.message || body.msg || `HTTP ${res.status}`} (code ${body.code ?? '?'})`);
  }
  return body;
}

export class MexcPublicClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  async fetchKlines(symbol, bars = 600, nowMs = Date.now()) {
    const endSec = Math.floor(nowMs / 1000);
    const startSec = endSec - bars * (TIMEFRAME_MS / 1000) - (TIMEFRAME_MS / 1000);
    const qs = new URLSearchParams({ interval: MEXC_KLINE_INTERVAL, start: String(startSec), end: String(endSec) });
    const res = await fetch(`${this.base}/api/v1/contract/kline/${encodeURIComponent(symbol)}?${qs}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await parseJson(res, `kline ${symbol}`);
    const d = body.data || {};
    const out = [];
    for (let i = 0; i < (d.time || []).length; i++) {
      out.push({
        t: Number(d.time[i]) * 1000,
        o: Number(d.open[i]),
        h: Number(d.high[i]),
        l: Number(d.low[i]),
        c: Number(d.close[i]),
        v: Number(d.vol?.[i] ?? 0),
      });
    }
    out.sort((a, b) => a.t - b.t);
    // Drop duplicates just in case the API repeats the boundary bar.
    return out.filter((c, i, arr) => i === 0 || c.t !== arr[i - 1].t);
  }

  async fetchContractSpec(symbol) {
    const qs = new URLSearchParams({ symbol });
    const res = await fetch(`${this.base}/api/v1/contract/detail?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await parseJson(res, `contract ${symbol}`);
    const list = Array.isArray(body.data) ? body.data : [body.data];
    const d = list.find((x) => x && x.symbol === symbol);
    if (!d) throw new Error(`contract ${symbol} not found`);
    return {
      symbol,
      contractSize: Number(d.contractSize),
      volUnit: Number(d.volUnit),
      minVol: Number(d.minVol),
      volScale: Number(d.volScale),
      priceUnit: Number(d.priceUnit),
      priceScale: Number(d.priceScale),
      takerFeeRate: Number(d.takerFeeRate),
      makerFeeRate: Number(d.makerFeeRate),
      maxLeverage: Number(d.maxLeverage),
      apiAllowed: d.apiAllowed !== false,
      state: d.state,
    };
  }
}

export class MexcPrivateClient {
  constructor({ baseUrl, apiKey, apiSecret, recvWindow = 10000 }) {
    this.base = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.recvWindow = recvWindow;
  }

  sign(requestTime, paramString) {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(this.apiKey + requestTime + paramString)
      .digest('hex');
  }

  static queryString(params = {}) {
    return Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
      .join('&');
  }

  async request(method, path, params = {}) {
    const requestTime = String(Date.now());
    let url = `${this.base}${path}`;
    const headers = {
      ApiKey: this.apiKey,
      'Request-Time': requestTime,
      'Recv-Window': String(this.recvWindow),
    };
    let init = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };

    if (method === 'GET' || method === 'DELETE') {
      const qs = MexcPrivateClient.queryString(params);
      if (qs) url += `?${qs}`;
      headers.Signature = this.sign(requestTime, qs);
    } else {
      const bodyStr = JSON.stringify(params);
      headers.Signature = this.sign(requestTime, bodyStr);
      headers['Content-Type'] = 'application/json';
      init = { ...init, body: bodyStr };
    }

    const res = await fetch(url, init);
    return parseJson(res, `${method} ${path}`);
  }

  /** USDT futures wallet: { equity, availableBalance, cashBalance, unrealized, positionMargin } */
  async getAsset(currency = 'USDT') {
    const body = await this.request('GET', `/api/v1/private/account/asset/${currency}`);
    return body.data;
  }

  async getOpenPositions() {
    const body = await this.request('GET', '/api/v1/private/position/open_positions');
    return body.data || [];
  }

  async getHistoryPositions(symbol, pageSize = 20) {
    const body = await this.request('GET', '/api/v1/private/position/list/history_positions', {
      symbol,
      page_num: 1,
      page_size: pageSize,
    });
    return body.data?.resultList || [];
  }

  /** Market open with attached stop-loss and take-profit (exchange-side protection). */
  async placeMarketOpen({ symbol, side, vol, leverage, price, stopLossPrice, takeProfitPrice, positionMode, externalOid }) {
    const body = await this.request('POST', '/api/v1/private/order/create', {
      symbol,
      price,
      vol,
      leverage,
      side, // 1 open long, 3 open short
      type: 5, // market
      openType: 1, // isolated margin
      stopLossPrice,
      takeProfitPrice,
      lossTrend: 1, // latest price triggers
      profitTrend: 1,
      positionMode,
      externalOid,
    });
    return body.data; // { orderId, ts }
  }
}
