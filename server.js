'use strict';
/**
 * SOL RSI Monitor — 纯 REST 服务器（无 WebSocket）
 *
 * Dashboard 通过每 5 秒轮询 REST API 刷新数据。
 *
 * HTTP 接口：
 *   POST /webhook/add-token    ← 扫描服务器推送新代币
 *   POST /webhook/remove-token ← 手动移除
 *   GET  /api/whitelist
 *   GET  /api/signals[?limit=N]
 *   GET  /api/stats
 *   GET  /health
 *   GET  /                     → Dashboard 页面
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const {
  addToken,
  removeToken,
  runPollingCycle,
  getWhitelist,
  getSignalHistory,
  getStats,
  POLL_INTERVAL_SEC,
} = require('./monitor');
const logger = require('./logger');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3003;

// ── 中间件 ────────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── HTTP 路由 ─────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), stats: getStats() });
});

/**
 * POST /webhook/add-token
 * Body: { network, address, symbol }
 */
app.post('/webhook/add-token', async (req, res) => {
  const { network, address, symbol } = req.body || {};

  if (!address || typeof address !== 'string' || address.trim() === '') {
    return res.status(400).json({ success: false, error: 'address is required' });
  }

  const addr = address.trim();
  logger.info(`[HTTP] /webhook/add-token symbol=${symbol} address=${addr} network=${network}`);

  const result = await addToken(addr, symbol, network || 'solana');

  if (result.success) {
    return res.json({
      success: true,
      message: `${result.token.symbol} added to whitelist`,
      token:   result.token,
    });
  }

  return res.json({ success: false, reason: result.reason, fdv: result.fdv });
});

/**
 * POST /webhook/remove-token
 * Body: { address }
 */
app.post('/webhook/remove-token', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ success: false, error: 'address is required' });

  await removeToken(address.trim(), 'manual');
  return res.json({ success: true });
});

app.get('/api/whitelist', (_req, res) => {
  res.json(getWhitelist());
});

app.get('/api/signals', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(getSignalHistory(limit));
});

app.get('/api/stats', (_req, res) => {
  res.json(getStats());
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── 策略轮询循环 ───────────────────────────────────────────────────────────────
let pollingActive = false;

function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  logger.info(`[Poll] 启动轮询，间隔 ${POLL_INTERVAL_SEC}s`);

  async function tick() {
    if (!pollingActive) return;
    try {
      await runPollingCycle();
    } catch (e) {
      logger.error(`[Poll] 周期出错: ${e.message}`);
    }
    if (pollingActive) setTimeout(tick, POLL_INTERVAL_SEC * 1000);
  }

  setTimeout(tick, POLL_INTERVAL_SEC * 1000);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[Server] 监听 0.0.0.0:${PORT}`);
  logger.info(`[Server] Dashboard  → http://localhost:${PORT}`);
  logger.info(`[Server] Add-token  → POST http://localhost:${PORT}/webhook/add-token`);
  startPolling();
});

// ── 优雅退出 ─────────────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`[Server] 收到 ${signal}，正在退出`);
  pollingActive = false;
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
