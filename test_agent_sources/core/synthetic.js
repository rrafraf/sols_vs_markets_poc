"use strict";

const { clamp } = require("./policy.js");

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSyntheticCandles({ n = 4000, startPrice = 250, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const candles = [];
  let price = startPrice;
  let vol = 0.0018;
  const start = Date.UTC(2025, 0, 2, 14, 30);

  for (let i = 0; i < n; i++) {
    vol = 0.85 * vol + 0.15 * 0.0018 + (rand() - 0.5) * 0.0003;
    vol = clamp(vol, 0.0004, 0.006);

    // Intentional slight positive drift retained from the old smoke test.
    const ret = (rand() - 0.48) * vol * 2;
    const open = price;
    const close = price * (1 + ret);
    const high = Math.max(open, close) * (1 + rand() * vol);
    const low = Math.min(open, close) * (1 - rand() * vol);
    price = close;

    const t = start + i * 60 * 1000;
    candles.push({
      time: Math.floor(t / 1000),
      open,
      high,
      low,
      close,
      isoTime: new Date(t).toISOString()
    });
  }

  return candles;
}

function makeDummySensorFn(candles, seed = 2) {
  const rand = mulberry32(seed);
  const scores = new Array(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const ret = Math.log(candles[i].close / candles[i - 1].close);
    scores[i] = 0.97 * scores[i - 1] + 0.12 * Math.tanh(ret * 120);
  }

  return (index) => {
    const s = scores[index] || 0;
    const noise = () => (rand() - 0.5) * 0.12;
    return {
      geometry: { value: clamp(s * 1.1 + noise(), -1, 1), attention: clamp(0.55 + Math.abs(s) * 0.4, 0, 1) },
      motion: { value: clamp(s * 1.2 + noise(), -1, 1), attention: clamp(0.50 + Math.abs(s) * 0.45, 0, 1) },
      momentum: { value: clamp(s * 0.9 + noise(), -1, 1), attention: clamp(0.45 + Math.abs(s) * 0.4, 0, 1) },
      pressure: { value: clamp(s * 0.6 + noise(), -1, 1), attention: 0.35 },
      regime: { value: 0.15 + noise() * 0.2, attention: 0.25 },
      volatility: { value: noise() * 0.4, attention: 0.2 },
      atr: candles[index].close * 0.0045,
      memory: {
        score: clamp(s * 0.8, -1, 1),
        confidence: clamp(0.55 + Math.abs(s) * 0.35, 0, 1)
      }
    };
  };
}

module.exports = { mulberry32, makeSyntheticCandles, makeDummySensorFn };
