import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { BinanceFuturesClient } from './binanceFuturesClient.js';

const balances = [{ asset: 'USDT', balance: '1000', availableBalance: '900', crossWalletBalance: '1000', crossUnPnl: '0', updateTime: 123 }];
const makeClient = () => new BinanceFuturesClient('https://exchange.invalid', 'wss://exchange.invalid', 'fixture-key', 'fixture-secret', pino({ level: 'silent' }));
const mockResponses = (regular: unknown = [], algo: unknown = []) => {
  const mock = vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    return new Response(JSON.stringify(path === '/fapi/v3/balance' ? balances : path === '/fapi/v1/openOrders' ? regular : algo), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
};
afterEach(() => vi.unstubAllGlobals());

describe('live open order count', () => {
  it('counts regular and conditional orders in the configured symbol', async () => {
    const mock = mockResponses([{orderId: 1, symbol: 'BTCUSDT'}], [{algoId: 1, symbol: 'BTCUSDT'}, {algoId: 2, symbol: 'BTCUSDT'}]);
    expect((await makeClient().getBalanceState('BTCUSDT')).openOrders).toBe(3);
    expect(mock).toHaveBeenCalledTimes(3);
    for (const [input] of mock.mock.calls) {
      const url = new URL(input);
      expect(url.searchParams.get('signature')).toMatch(/^[a-f0-9]{64}$/);
      if (url.pathname !== '/fapi/v3/balance') expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    }
  });
  it('reports zero only when both order endpoints return empty arrays', async () => {
    mockResponses();
    expect((await makeClient().getBalanceState('BTCUSDT')).openOrders).toBe(0);
  });
  it.each([null, {}, [{orderId: 1, symbol: 'ETHUSDT'}], [{orderId: NaN, symbol: 'BTCUSDT'}], [{orderId: 0, symbol: 'BTCUSDT'}], [{orderId: 1, symbol: 'BTCUSDT'}, {orderId: 1, symbol: 'BTCUSDT'}]])(
    'rejects malformed or duplicate regular orders instead of publishing a zero count: %j', async (payload) => {
      mockResponses(payload);
      await expect(makeClient().getBalanceState('BTCUSDT')).rejects.toThrow('Invalid open-order response');
    });
  it.each([{}, [null], [{algoId: '1', symbol: 'BTCUSDT'}], [{algoId: 1, symbol: 'ETHUSDT'}]])(
    'rejects malformed conditional orders: %j', async (payload) => {
      mockResponses([], payload);
      await expect(makeClient().getBalanceState('BTCUSDT')).rejects.toThrow('Invalid open-order response');
    });
  it('propagates order query failures instead of returning a partial account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (new URL(input).pathname === '/fapi/v1/openAlgoOrders') throw new Error('fixture unavailable');
      return new Response(JSON.stringify(new URL(input).pathname === '/fapi/v3/balance' ? balances : []));
    }));
    await expect(makeClient().getBalanceState('BTCUSDT')).rejects.toThrow('fixture unavailable');
  });
  it('rejects missing or invalid symbols before making a network request', async () => {
    const mock = mockResponses();
    await expect(makeClient().getBalanceState('')).rejects.toThrow('valid symbol');
    expect(mock).not.toHaveBeenCalled();
  });
});
