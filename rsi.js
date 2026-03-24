'use strict';
/**
 * RSI Calculator + 5-second candle aggregator
 *
 * RSI 使用 Wilder 平滑法（标准 RSI）。
 *
 * prevRSI 更新时机说明：
 *   prevRSI 只在新 K 线开启时更新，而非每次 poll tick。
 *   同一个 5 秒桶内多次 poll → 收盘价相同 → RSI 相同，
 *   crossup/crossdown 永远无法在桶内触发。
 *   解决方案：addPriceTick 返回 newCandleOpened 标志，
 *   调用方只在新 K 线开启时才推进 prevRSI。
 */

/**
 * 计算 RSI（Wilder 平滑）
 * closes 数组从旧到新排列，长度不足 period+1 时返回 null。
 *
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number|null}
 */
function calculateRSI(closes, period = 7) {
  if (!closes || closes.length < period + 1) return null;

  // 初始 avgGain / avgLoss：前 period 根 K 线的简单平均
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else          avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder 平滑：对剩余每根 K 线迭代
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * RSI 上穿检测：前一根 K 线 RSI <= threshold，当前 K 线 RSI > threshold。
 *
 * @param {number|null} prevRSI
 * @param {number|null} currRSI
 * @param {number}      threshold
 * @returns {boolean}
 */
function isRSICrossUp(prevRSI, currRSI, threshold = 30) {
  if (prevRSI === null || prevRSI === undefined) return false;
  if (currRSI === null || currRSI === undefined) return false;
  return prevRSI <= threshold && currRSI > threshold;
}

/**
 * RSI 下穿检测：前一根 K 线 RSI >= threshold，当前 K 线 RSI < threshold。
 *
 * @param {number|null} prevRSI
 * @param {number|null} currRSI
 * @param {number}      threshold
 * @returns {boolean}
 */
function isRSICrossDown(prevRSI, currRSI, threshold = 70) {
  if (prevRSI === null || prevRSI === undefined) return false;
  if (currRSI === null || currRSI === undefined) return false;
  return prevRSI >= threshold && currRSI < threshold;
}

/**
 * 向 K 线数组追加一个价格 tick。
 *
 * 根据当前时间戳判断所属 5 秒桶：
 *   - 同一桶 → 更新当前 K 线的 high / low / close / volume
 *   - 新桶   → 封闭当前 K 线，开启新 K 线（open = 上一根 close）
 *
 * @param {Object[]} candles      - 可变 K 线数组（旧在前）
 * @param {number}   price        - 当前价格
 * @param {number}   volume       - 成交量（可选）
 * @param {number}   intervalSec  - K 线周期（秒），默认 5
 * @param {number}   maxCandles   - 最大保留根数，默认 120
 * @returns {{ candles: Object[], newCandleOpened: boolean }}
 */
function addPriceTick(candles, price, volume = 0, intervalSec = 5, maxCandles = 120) {
  const now        = Date.now();
  const intervalMs = intervalSec * 1000;
  const bucketTs   = Math.floor(now / intervalMs) * intervalMs;

  const last            = candles[candles.length - 1];
  let   newCandleOpened = false;

  if (last && last.timestamp === bucketTs) {
    // 同一桶：更新当前 K 线
    last.high   = Math.max(last.high, price);
    last.low    = Math.min(last.low,  price);
    last.close  = price;
    last.volume += volume;
  } else {
    // 新桶：用上一根收盘价作开盘价，保证价格连续性
    const open = last ? last.close : price;
    candles.push({
      timestamp: bucketTs,
      open,
      high:   price,
      low:    price,
      close:  price,
      volume,
    });
    newCandleOpened = true;

    // 滚动窗口裁剪
    if (candles.length > maxCandles) {
      candles.splice(0, candles.length - maxCandles);
    }
  }

  return { candles, newCandleOpened };
}

module.exports = { calculateRSI, isRSICrossUp, isRSICrossDown, addPriceTick };
