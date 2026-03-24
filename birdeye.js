'use strict';
/**
 * BirdEye API Client（Premium Plus）
 *
 * 使用的接口：
 *   GET /defi/price          — 单币实时价格
 *   GET /defi/token_overview — FDV、流动性、元数据
 */

const axios = require('axios');

const BASE_URL = process.env.BIRDEYE_BASE_URL || 'https://public-api.birdeye.so';
const API_KEY  = process.env.BIRDEYE_API_KEY  || '';

if (!API_KEY) {
  console.warn('[BirdEye] WARNING: BIRDEYE_API_KEY is not set in .env');
}

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 8000,
  headers: {
    'X-API-KEY':    API_KEY,
    'x-chain':      'solana',
    'Content-Type': 'application/json',
  },
});

/**
 * 带指数退避的重试包装器。
 * 网络错误和 5xx 会重试；4xx 直接抛出，不重试。
 */
async function withRetry(fn, retries = 3, baseDelayMs = 600) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) throw err; // 4xx 不重试
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * 获取单个代币当前价格。
 * @param  {string} address — 代币 mint 地址
 * @returns {{ price: number, updateTime: number, liquidity: number }}
 */
async function getTokenPrice(address) {
  return withRetry(async () => {
    const res = await client.get('/defi/price', {
      params: { address, include_liquidity: true },
    });
    const d = res.data?.data;
    if (!d || !d.value) throw new Error(`No price data for ${address}`);
    return {
      price:      d.value,
      updateTime: d.updateUnixTime,
      liquidity:  d.liquidity ?? 0,
    };
  });
}

/**
 * 获取代币概况：FDV、流动性、Symbol、创建时间等。
 * 首次加入白名单时调用，之后每 60 秒刷新一次。
 * @param  {string} address
 * @returns {Object}
 */
async function getTokenOverview(address) {
  return withRetry(async () => {
    const res = await client.get('/defi/token_overview', {
      params: { address },
    });
    const d = res.data?.data;
    if (!d) throw new Error(`No overview for ${address}`);
    return {
      symbol:    d.symbol    || '',
      name:      d.name      || '',
      price:     d.price     || 0,
      fdv:       d.fdv       || 0,
      marketCap: d.marketCap || 0,
      liquidity: d.liquidity || 0,
      holder:    d.holder    || 0,
      createdAt: d.createdAt || null,
      logoURI:   d.logoURI   || '',
    };
  });
}

module.exports = { getTokenPrice, getTokenOverview };
