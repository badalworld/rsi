import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MexcPrivateClient } from '../src/mexcApi.js';

test('query string is sorted by key and skips null values', () => {
  const qs = MexcPrivateClient.queryString({ symbol: 'BTC_USDT', page_size: 20, page_num: 1, nothing: null });
  assert.equal(qs, 'page_num=1&page_size=20&symbol=BTC_USDT');
});

test('signature is HMAC-SHA256 over accessKey + requestTime + paramString (hex)', () => {
  const c = new MexcPrivateClient({ baseUrl: 'https://x', apiKey: 'AK', apiSecret: 'SECRET' });
  const body = JSON.stringify({ symbol: 'BTC_USDT', vol: 2, side: 1 });
  const expected = crypto.createHmac('sha256', 'SECRET').update('AK' + '1700000000000' + body).digest('hex');
  assert.equal(c.sign('1700000000000', body), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});
