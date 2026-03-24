'use strict';
/**
 * Monitor — 核心策略引擎
 *
 * 买入策略：
 *   RSI(7) 上穿 30（前一根 K 线 RSI ≤ 30，当前 K 线 RSI > 30）
 *   且当前无持仓（status === 'watching'）
 *
 * 卖出策略（满足任一即触发）：
 *   - RSI ≥ 80：当前 RSI 极度超买（优先判断）
 *   - RSI 下穿 70：prevRSI ≥ 70 且 currRSI < 70
 *
 * 多次买卖：
 *   卖出后状态置为 sold，5 秒后重置为 watching，允许再次触发买入。
 *
 * 白名单退出（强制移除）：
 *   - 实时 FDV < $10,000（FDV 已知时）
 *   - 监控时长超过 30 分钟
 */

const { getTokenPrice, getTokenOverview } = require('./birdeye');
const { calculateRSI, isRSICrossUp, isRSICrossDown, addPriceTick } = require('./rsi');
const { sendBuySignal, sendSellSignal } = require('./webhook');
const logger = require('./logger');

// ── 策略参数（从 .env 读取）────────────────────────────────────────────────────
const RSI_PERIOD           = parseInt(process.env.RSI_PERIOD)            || 7;
const RSI_OVERSOLD         = parseFloat(process.env.RSI_OVERSOLD)        || 30;
const RSI_OVERBOUGHT       = parseFloat(process.env.RSI_OVERBOUGHT)      || 70;
const RSI_EXTREME          = parseFloat(process.env.RSI_EXTREME)         || 80;
const MONITOR_DURATION_MIN = parseInt(process.env.MONITOR_DURATION_MIN)  || 30;
const MIN_FDV              = parseFloat(process.env.MIN_FDV)             || 10000;
const MAX_WHITELIST_SIZE   = parseInt(process.env.MAX_WHITELIST_SIZE)    || 10;
const CANDLE_INTERVAL_SEC  = parseInt(process.env.CANDLE_INTERVAL_SEC)   || 5;
const POLL_INTERVAL_SEC    = parseInt(process.env.POLL_INTERVAL_SEC)     || 5;

// sold 状态保留时间（毫秒），让 Dashboard 短暂看到已卖状态后重置为 watching
const SOLD_RETAIN_MS = 5000;

// ── 内存状态 ─────────────────────────────────────────────────────────────────
/** @type {Map<string, TokenState>} */
const tokenMap = new Map();

/** 信号历史（最新在前），上限 500 条 */
const signalHistory = [];
const MAX_SIGNALS   = 500;

// ── TokenState 工厂函数 ───────────────────────────────────────────────────────
function createTokenState(address, symbol, network, overview) {
  return {
    address,
    symbol:            symbol || overview?.symbol || '???',
    network:           network || 'solana',
    addedAt:           Date.now(),
    entryPrice:        overview?.price     || null, // 收录时价格（首次 poll 若为空则补填）
    currentPrice:      overview?.price     || null,
    fdv:               overview?.fdv       || 0,
    liquidity:         overview?.liquidity || 0,
    candles:           [],   // 5 秒 OHLCV K 线，旧在前
    prevRSI:           null, // 上一根已封闭 K 线的 RSI
    currRSI:           null, // 当前 K 线的 RSI
    status:            'watching', // 'watching' | 'bought' | 'sold'
    hasBought:         false, // 当前是否持仓（卖出后重置）
    boughtAt:          null,  // 本次买入价格
    pnlPercent:        0,     // 当前持仓浮动 PNL %
    totalPnlPct:       0,     // 累计已实现 PNL %
    tradeCount:        0,     // 已完成交易次数
    signalCount:       0,     // 总信号次数
    lastSignalTs:      null,
    lastPollTs:        null,
    overviewUpdatedAt: Date.now(),
  };
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 将代币加入白名单。
 * FDV < MIN_FDV 或白名单已满时拒绝。
 */
async function addToken(address, symbol, network) {
  if (tokenMap.has(address)) {
    return { success: false, reason: 'already_monitored', token: tokenMap.get(address) };
  }

  if (tokenMap.size >= MAX_WHITELIST_SIZE) {
    logger.warn(`[Monitor] 白名单已满 (${MAX_WHITELIST_SIZE})，拒绝 ${symbol} (${address})`);
    return { success: false, reason: 'whitelist_full' };
  }

  let overview = null;
  try {
    overview = await getTokenOverview(address);
  } catch (e) {
    logger.warn(`[Monitor] Overview 获取失败 ${symbol} (${address}): ${e.message}，跳过 FDV 检查`);
  }

  const fdv = overview?.fdv || 0;
  if (fdv > 0 && fdv < MIN_FDV) {
    logger.info(`[Monitor] 拒绝 ${symbol} (${address}): FDV=$${fdv} < $${MIN_FDV}`);
    return { success: false, reason: 'fdv_too_low', fdv };
  }

  const state = createTokenState(address, symbol, network, overview);
  tokenMap.set(address, state);
  logger.info(`[Monitor] 加入白名单 ${state.symbol} (${address}) FDV=$${fdv} entryPrice=${state.entryPrice}`);
  return { success: true, token: _toPublic(state) };
}

/**
 * 从白名单移除代币（幂等）。
 * 若当前持仓（status === 'bought'），先发卖出信号再移除。
 */
async function removeToken(address, reason = 'manual') {
  const state = tokenMap.get(address);
  if (!state) return;

  if (state.status === 'bought') {
    logger.info(`[Monitor] 退出卖出 ${state.symbol} (${address}) reason=${reason}`);
    await sendSellSignal(state.address, state.symbol, `EXIT_${reason.toUpperCase()}`);
    _recordSignal(state, 'SELL', `EXIT_${reason.toUpperCase()}`, state.currentPrice);
    state.totalPnlPct += state.pnlPercent;
  }

  tokenMap.delete(address);
  logger.info(`[Monitor] 已移除 ${state.symbol} (${address}) reason=${reason}`);
}

/**
 * 轮询单个代币：拉价格 → 更新 K 线 → 计算 RSI → 执行策略 → 检查退出条件。
 */
async function pollToken(address) {
  const state = tokenMap.get(address);
  if (!state) return;

  // sold 期间等待 setTimeout 重置，不参与策略
  if (state.status === 'sold') return;

  try {
    // 1. 拉取实时价格
    const priceData = await getTokenPrice(address);
    const price = priceData.price;
    if (!price || price <= 0) {
      logger.warn(`[Poll] 价格为零/null: ${state.symbol} (${address})，跳过`);
      return;
    }

    state.currentPrice = price;
    state.lastPollTs   = Date.now();

    // 2. 首次拉到价格时补填 entryPrice
    if (!state.entryPrice) {
      state.entryPrice = price;
      logger.info(`[Poll] 入场价设定 ${state.symbol}: ${price}`);
    }

    // 3. 更新 5 秒 K 线，获取是否开启了新桶
    const { newCandleOpened } = addPriceTick(
      state.candles, price, 0, CANDLE_INTERVAL_SEC, 120
    );

    // 4. 仅新 K 线开启时推进 prevRSI，防止同桶内多次 poll 误触 crossup/crossdown
    if (newCandleOpened) {
      state.prevRSI = state.currRSI;
    }

    // 5. 用全部收盘价重新计算 RSI
    state.currRSI = calculateRSI(state.candles.map(c => c.close), RSI_PERIOD);

    // 6. 每 60 秒后台刷新 FDV / LP（fire-and-forget）
    if (Date.now() - state.overviewUpdatedAt > 60_000) {
      _refreshOverview(state);
    }

    // 7. 执行买卖策略
    const justBought = await _runStrategy(state);

    // 8. 检查白名单退出条件
    //    - justBought 时跳过：防止刚买入就因超时退出
    //    - status === 'sold' 时跳过：卖出后等待重置，不应强制移除
    if (!justBought && tokenMap.has(address)) {
      await _checkExitConditions(state);
    }

  } catch (err) {
    logger.error(`[Poll] 轮询出错 ${state.symbol} (${address}): ${err.message}`);
  }
}

/**
 * 对所有白名单代币执行一轮并发轮询。
 */
async function runPollingCycle() {
  const addresses = Array.from(tokenMap.keys());
  if (addresses.length === 0) return;
  await Promise.allSettled(addresses.map(addr => pollToken(addr)));
}

// ── 私有：策略逻辑 ────────────────────────────────────────────────────────────

/**
 * 核心买卖策略。返回 true 表示本轮触发了买入（调用方跳过退出检查）。
 *
 * 买入：RSI(7) 上穿 30，当前无持仓
 * 卖出（任一）：
 *   1. RSI ≥ 80（优先）
 *   2. RSI 下穿 70
 */
async function _runStrategy(state) {
  const { address, symbol, currentPrice, currRSI, prevRSI } = state;

  if (!currentPrice) return false;

  // ── 买入：RSI 上穿 30 ──────────────────────────────────────────────────────
  if (state.status === 'watching') {
    const rsiCrossUp = isRSICrossUp(prevRSI, currRSI, RSI_OVERSOLD);

    logger.debug(
      `[Strategy] ${symbol} prevRSI=${prevRSI?.toFixed(1) ?? 'N/A'} ` +
      `currRSI=${currRSI?.toFixed(1) ?? 'N/A'} crossUp=${rsiCrossUp}`
    );

    if (rsiCrossUp) {
      logger.info(
        `[Strategy] ★ BUY ${symbol} | price=${currentPrice} ` +
        `RSI ${prevRSI.toFixed(1)}→${currRSI.toFixed(1)}`
      );

      await sendBuySignal(address, symbol);

      state.boughtAt     = currentPrice;
      state.hasBought    = true;
      state.status       = 'bought';
      state.pnlPercent   = 0;
      state.lastSignalTs = Date.now();

      _recordSignal(state, 'BUY', 'RSI_CROSSUP_30', currentPrice, {
        rsiPrev: prevRSI,
        rsiCurr: currRSI,
      });

      return true; // 本轮已买入，跳过退出检查
    }
  }

  // ── 卖出 ──────────────────────────────────────────────────────────────────
  if (state.status === 'bought') {
    // 更新实时浮动 PNL
    if (state.boughtAt) {
      const pnlPct     = (currentPrice - state.boughtAt) / state.boughtAt;
      state.pnlPercent = parseFloat((pnlPct * 100).toFixed(2));
    }

    // 条件1：RSI ≥ 80（极度超买，优先判断，避免被下穿70逻辑先拦截）
    if (currRSI !== null && currRSI >= RSI_EXTREME) {
      logger.info(
        `[Strategy] ★ SELL RSI_EXTREME ${symbol} | pnl=${state.pnlPercent}% RSI=${currRSI.toFixed(1)}`
      );
      await sendSellSignal(address, symbol, 'RSI_EXTREME_80');
      _recordSignal(state, 'SELL', 'RSI_EXTREME_80', currentPrice, {
        pnlPct:  state.pnlPercent,
        rsiCurr: currRSI,
      });
      _resetAfterSell(state);
      return false;
    }

    // 条件2：RSI 下穿 70（prevRSI ≥ 70 且 currRSI < 70）
    const rsiCrossDown = isRSICrossDown(prevRSI, currRSI, RSI_OVERBOUGHT);
    if (rsiCrossDown) {
      logger.info(
        `[Strategy] ★ SELL RSI_CROSSDOWN_70 ${symbol} | pnl=${state.pnlPercent}% ` +
        `RSI ${prevRSI.toFixed(1)}→${currRSI.toFixed(1)}`
      );
      await sendSellSignal(address, symbol, 'RSI_CROSSDOWN_70');
      _recordSignal(state, 'SELL', 'RSI_CROSSDOWN_70', currentPrice, {
        pnlPct:  state.pnlPercent,
        rsiPrev: prevRSI,
        rsiCurr: currRSI,
      });
      _resetAfterSell(state);
      return false;
    }
  }

  return false;
}

/**
 * 卖出后重置状态，5 秒后回到 watching，允许再次买入。
 */
function _resetAfterSell(state) {
  state.totalPnlPct += state.pnlPercent;
  state.tradeCount  += 1;
  state.status       = 'sold';
  state.lastSignalTs = Date.now();

  setTimeout(async () => {
    // 代币已被强制退出则跳过
    if (!tokenMap.has(state.address)) return;
    state.status     = 'watching';
    state.hasBought  = false;
    state.boughtAt   = null;
    state.pnlPercent = 0;
    logger.info(`[Monitor] ${state.symbol} 重置为 watching，允许再次买入`);
    // 重置后立即补检一次退出条件，防止 sold 窗口期掩盖了已超时/FDV过低的情况
    await _checkExitConditions(state);
  }, SOLD_RETAIN_MS);
}

/**
 * 检查白名单退出条件。
 * - status === 'sold' 时跳过：正在 5 秒重置窗口内，不应被强制移除
 * - FDV < MIN_FDV 时退出
 * - 监控时长 ≥ MONITOR_DURATION_MIN 时退出
 */
async function _checkExitConditions(state) {
  if (!tokenMap.has(state.address)) return;

  // sold 期间等待 setTimeout 重置，不触发退出
  if (state.status === 'sold') return;

  const ageMin    = (Date.now() - state.addedAt) / 60_000;
  const fdvTooLow = state.fdv > 0 && state.fdv < MIN_FDV;
  const tooOld    = ageMin >= MONITOR_DURATION_MIN;

  if (fdvTooLow || tooOld) {
    // fdvTooLow 优先；两者同时满足时在日志里都记录
    const reason = fdvTooLow ? 'fdv_too_low' : 'age_expired';
    logger.info(
      `[Monitor] 自动退出 ${state.symbol} reason=${reason} ` +
      `age=${ageMin.toFixed(1)}min fdv=${state.fdv}` +
      (fdvTooLow && tooOld ? ' (age also expired)' : '')
    );
    await removeToken(state.address, reason);
  }
}

/**
 * 后台刷新 FDV / LP（fire-and-forget，失败不影响主流程）。
 */
async function _refreshOverview(state) {
  try {
    const ov = await getTokenOverview(state.address);
    state.fdv               = ov.fdv       || state.fdv;
    state.liquidity         = ov.liquidity || state.liquidity;
    state.overviewUpdatedAt = Date.now();
    logger.debug(`[Monitor] Overview 已刷新 ${state.symbol} FDV=$${state.fdv}`);
  } catch (e) {
    logger.warn(`[Monitor] Overview 刷新失败 ${state.symbol}: ${e.message}`);
  }
}

/**
 * 向信号历史追加一条记录（环形缓冲，上限 MAX_SIGNALS）。
 */
function _recordSignal(state, type, strategy, price, extras = {}) {
  const signal = {
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    address:   state.address,
    symbol:    state.symbol,
    type,      // 'BUY' | 'SELL'
    strategy,  // 'RSI_CROSSUP_30' | 'RSI_EXTREME_80' | 'RSI_CROSSDOWN_70' | 'EXIT_*'
    price,
    rsi: state.currRSI !== null ? parseFloat(state.currRSI.toFixed(2)) : null,
    ...extras,
  };
  signalHistory.unshift(signal);
  if (signalHistory.length > MAX_SIGNALS) signalHistory.pop();
  state.signalCount++;
}

// ── 序列化（内部 state → 对外 JSON）─────────────────────────────────────────

function _toPublic(s) {
  const ageMin = (Date.now() - s.addedAt) / 60_000;
  return {
    address:      s.address,
    symbol:       s.symbol,
    network:      s.network,
    addedAt:      s.addedAt,
    ageMin:       parseFloat(ageMin.toFixed(1)),
    entryPrice:   s.entryPrice,
    currentPrice: s.currentPrice,
    fdv:          s.fdv,
    liquidity:    s.liquidity,
    currRSI:      s.currRSI !== null ? parseFloat(s.currRSI.toFixed(2)) : null,
    prevRSI:      s.prevRSI !== null ? parseFloat(s.prevRSI.toFixed(2)) : null,
    status:       s.status,
    hasBought:    s.hasBought,
    boughtAt:     s.boughtAt,
    pnlPercent:   parseFloat((s.pnlPercent  || 0).toFixed(2)),
    totalPnlPct:  parseFloat((s.totalPnlPct || 0).toFixed(2)),
    tradeCount:   s.tradeCount  || 0,
    signalCount:  s.signalCount,
    lastSignalTs: s.lastSignalTs,
    lastPollTs:   s.lastPollTs,
    candleCount:  s.candles.length,
    candles:      s.candles.slice(-30), // 最近 30 根供 Dashboard 迷你图
  };
}

// ── Dashboard 数据接口 ────────────────────────────────────────────────────────

function getWhitelist() {
  return Array.from(tokenMap.values()).map(_toPublic);
}

function getSignalHistory(limit = 100) {
  return signalHistory.slice(0, Math.min(limit, MAX_SIGNALS));
}

function getStats() {
  const tokens   = Array.from(tokenMap.values());
  const watching = tokens.filter(t => t.status === 'watching').length;
  const bought   = tokens.filter(t => t.status === 'bought').length;
  const sold     = tokens.filter(t => t.status === 'sold').length;
  const totalPnl = tokens.reduce((sum, t) => sum + (t.totalPnlPct || 0), 0);
  return {
    total:       tokens.length,
    watching,
    bought,
    sold,
    signalCount: signalHistory.length,
    totalPnlPct: parseFloat(totalPnl.toFixed(2)),
  };
}

module.exports = {
  addToken,
  removeToken,
  pollToken,
  runPollingCycle,
  getWhitelist,
  getSignalHistory,
  getStats,
  POLL_INTERVAL_SEC,
};
