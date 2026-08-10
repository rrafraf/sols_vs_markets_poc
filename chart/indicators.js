"use strict";

export function rsi(bars, context = {}) {
  const period = context.options?.period || rsi.indicator.period || 14;
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
