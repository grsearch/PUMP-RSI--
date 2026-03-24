'use strict';
/**
 * Webhook Sender — 向交易服务器发送买入 / 卖出信号
 *
 * 买入 → POST { mint, symbol }           to TRADE_WEBHOOK_BUY_URL
 * 卖出 → POST { mint, signal, reason }   to TRADE_WEBHOOK_SELL_URL
 */

const axios  = require('axios');
const logger = require('./logger');

const BUY_URL  = process.env.TRADE_WEBHOOK_BUY_URL  || 'http://43.165.7.149:3002/webhook/new-token';
const SELL_URL = process.env.TRADE_WEBHOOK_SELL_URL || 'http://43.165.7.149:3002/force-sell';

const HTTP_OPTS = {
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' },
};

/**
 * 发送买入信号
 * 格式: { mint, symbol }
 */
async function sendBuySignal(mint, symbol) {
  const payload = { mint, symbol };
  try {
    const res = await axios.post(BUY_URL, payload, HTTP_OPTS);
    logger.info(`[Webhook] BUY  sent  ${symbol} (${mint}) → HTTP ${res.status}`);
    return { success: true, status: res.status };
  } catch (err) {
    const status = err?.response?.status || 'ERR';
    logger.error(`[Webhook] BUY  FAILED ${symbol} (${mint}) → ${status} ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 发送卖出信号
 * 格式: { mint, signal: "SELL", reason }
 */
async function sendSellSignal(mint, symbol, reason = 'SELL') {
  const payload = { mint, signal: 'SELL', reason };
  try {
    const res = await axios.post(SELL_URL, payload, HTTP_OPTS);
    logger.info(`[Webhook] SELL sent  ${symbol} (${mint}) reason=${reason} → HTTP ${res.status}`);
    return { success: true, status: res.status };
  } catch (err) {
    const status = err?.response?.status || 'ERR';
    logger.error(`[Webhook] SELL FAILED ${symbol} (${mint}) reason=${reason} → ${status} ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { sendBuySignal, sendSellSignal };
