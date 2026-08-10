"use strict";

const EPSILON = 1e-12;

export function rsi(bars, context = {}) {
  const period = positiveInt(context.options?.period, rsi.indicator.period || 14);
  const out = [];
  if (!Array.isArray(bars) || bars.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < bars.length; i++) {
    if (i > period) {
      const change = bars[i].close - bars[i - 1].close;
      const gain = Math.max(0, change);
      const loss = Math.max(0, -change);
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    const value = avgLoss === 0
      ? 100
      : 100 - 100 / (1 + avgGain / avgLoss);
    out.push({ time: bars[i].time, value });
  }

  return out;
}

rsi.indicator = {
  name: "RSI 14",
  period: 14,
  color: "#a371f7",
  pane: "separate",
  lineWidth: 1
};

/**
 * RSI state normalized to [-1, +1].
 * -1 = RSI 0, 0 = RSI 50, +1 = RSI 100.
 */
export function rsiLevel(bars, context = {}) {
  const period = positiveInt(context.options?.period, 5);
  return rsi(bars, { options: { period } }).map(point => ({
    ...point,
    rawRsi: point.value,
    value: clamp((point.value - 50) / 50, -1, 1)
  }));
}

rsiLevel.indicator = {
  name: "RSI 5 normalized",
  period: 5,
  pane: "separate",
  lineWidth: 1
};

/**
 * Causal RSI divergence detector.
 *
 * Compares the regression direction of log-price with RSI over the same
 * trailing window. It only emits when those directions oppose each other:
 *   +1-ish => price falling while RSI rises (bullish divergence)
 *   -1-ish => price rising while RSI falls (bearish divergence)
 *
 * No future-confirmed pivots are used.
 */
export function rsiDivergence(bars, context = {}) {
  const period = positiveInt(context.options?.period, 5);
  const lookback = Math.max(3, positiveInt(context.options?.lookback, 8));
  const rsiPoints = rsi(bars, { options: { period } });
  const barByTime = new Map(bars.map(bar => [bar.time, bar]));
  const out = [];

  for (let i = lookback - 1; i < rsiPoints.length; i++) {
    const window = rsiPoints.slice(i - lookback + 1, i + 1);
    const priceValues = [];
    const rsiValues = [];

    for (const point of window) {
      const bar = barByTime.get(point.time);
      if (!bar || !Number.isFinite(bar.close) || bar.close <= 0) continue;
      priceValues.push(Math.log(bar.close));
      rsiValues.push(point.value);
    }

    if (priceValues.length !== lookback) continue;

    const priceSlope = normalizedSlope(priceValues);
    const rsiSlope = normalizedSlope(rsiValues);
    const opposed = priceSlope * rsiSlope < 0;
    const value = opposed
      ? clamp((rsiSlope - priceSlope) / 2, -1, 1)
      : 0;

    out.push({
      time: window.at(-1).time,
      value,
      priceSlope,
      rsiSlope,
      bullish: value > 0,
      bearish: value < 0
    });
  }

  return out;
}

rsiDivergence.indicator = {
  name: "RSI divergence",
  period: 5,
  lookback: 8,
  pane: "separate",
  lineWidth: 1
};

/**
 * Causal RSI second derivative, converted into a bounded spike signal.
 *
 * 1. Calculate RSI.
 * 2. Optionally smooth it with a causal EMA.
 * 3. Calculate the discrete second derivative.
 * 4. Robustly normalize the derivative using only the trailing history.
 *
 * Output is roughly [-1, +1]; large positive values mean RSI is curving
 * upward unusually fast, large negative values mean it is curving downward.
 */
export function rsiAcceleration(bars, context = {}) {
  const period = positiveInt(context.options?.period, 5);
  const smoothPeriod = positiveInt(context.options?.smoothPeriod, 2);
  const normalizationWindow = Math.max(5, positiveInt(context.options?.normalizationWindow, 20));
  const clipZ = Math.max(0.5, finiteOr(context.options?.clipZ, 3));
  const points = rsi(bars, { options: { period } });
  if (points.length < 3) return [];

  const rawRsi = points.map(point => point.value);
  const smoothRsi = smoothPeriod > 1
    ? ema(rawRsi, smoothPeriod)
    : rawRsi.slice();
  const accelerations = new Array(points.length).fill(null);

  for (let i = 2; i < smoothRsi.length; i++) {
    accelerations[i] = smoothRsi[i] - 2 * smoothRsi[i - 1] + smoothRsi[i - 2];
  }

  const out = [];
  for (let i = 2; i < accelerations.length; i++) {
    const start = Math.max(2, i - normalizationWindow + 1);
    const history = accelerations.slice(start, i + 1).filter(Number.isFinite);
    if (history.length < 3) continue;

    const rawAcceleration = accelerations[i];
    const z = robustZScore(rawAcceleration, history);
    out.push({
      time: points[i].time,
      value: clamp(z / clipZ, -1, 1),
      rawAcceleration,
      zScore: z,
      rawRsi: rawRsi[i],
      smoothRsi: smoothRsi[i]
    });
  }

  return out;
}

rsiAcceleration.indicator = {
  name: "RSI acceleration",
  period: 5,
  smoothPeriod: 2,
  normalizationWindow: 20,
  clipZ: 3,
  pane: "separate",
  lineWidth: 1
};

function normalizedSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const meanY = mean(values);
  const meanX = (n - 1) / 2;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = values[i] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  if (varianceX <= EPSILON || varianceY <= EPSILON) return 0;
  const slope = covariance / varianceX;
  const sigma = Math.sqrt(varianceY / n);
  return clamp(slope * (n - 1) / (sigma + EPSILON), -1, 1);
}

function ema(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

function robustZScore(value, values) {
  const center = median(values);
  const deviations = values.map(v => Math.abs(v - center));
  const mad = median(deviations);
  if (mad > EPSILON) {
    return (value - center) / (1.4826 * mad);
  }

  const sigma = standardDeviation(values);
  return sigma > EPSILON ? (value - mean(values)) / sigma : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const center = mean(values);
  const variance = values.reduce((sum, value) => {
    const d = value - center;
    return sum + d * d;
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
