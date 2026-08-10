/**
 * Minimal harsh-test harness for agent-core.js
 * Run with: node test-agent-core.js
 *
 * This uses synthetic random-walk data so you can verify the engine
 * works without depending on the full lab or Alpaca. Replace the
 * sensorFn and candles with real ones from your SQLite / Alpaca later.
 */

"use strict";

const { simulate, walkForward, DEFAULT_CONFIG, opinion } = require("./agent-core.js");

// ---------------------------------------------------------------------------
// Synthetic 1-min bars (random walk with mild drift + volatility clustering)
// ---------------------------------------------------------------------------
function makeSyntheticCandles(n = 3000, startPrice = 250) {
  const candles = [];
  let price = startPrice;
  let vol = 0.0018;
  const start = Date.UTC(2025, 0, 2, 14, 30); // ~09:30 ET

  for (let i = 0; i < n; i++) {
    // mild mean-reverting vol
    vol = 0.85 * vol + 0.15 * 0.0018 + (Math.random() - 0.5) * 0.0003;
    vol = Math.max(0.0004, Math.min(0.006, vol));

    const ret = (Math.random() - 0.48) * vol * 2; // slight upward bias
    const open = price;
    const close = price * (1 + ret);
    const high = Math.max(open, close) * (1 + Math.random() * vol);
    const low = Math.min(open, close) * (1 - Math.random() * vol);
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

// ---------------------------------------------------------------------------
// Dummy sensor function (replace with real retina / analysis later)
// Produces mildly autocorrelated directional noise so the agent has something
// to react to. In production this will be your real geometry/motion/etc.
// ---------------------------------------------------------------------------
function makeDummySensorFn(candles) {
  const scores = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const ret = Math.log(candles[i].close / candles[i - 1].close);
    // stronger persistence so the agent actually fires on synthetic data
    scores[i] = 0.97 * scores[i - 1] + 0.12 * Math.tanh(ret * 120);
  }

  return (index) => {
    const s = scores[index] || 0;
    const noise = () => (Math.random() - 0.5) * 0.12;
    return {
      geometry: { value: clamp(s * 1.1 + noise(), -1, 1), attention: 0.55 + Math.abs(s) * 0.4 },
      motion: { value: clamp(s * 1.2 + noise(), -1, 1), attention: 0.50 + Math.abs(s) * 0.45 },
      momentum: { value: clamp(s * 0.9 + noise(), -1, 1), attention: 0.45 + Math.abs(s) * 0.4 },
      pressure: { value: clamp(s * 0.6 + noise(), -1, 1), attention: 0.35 },
      regime: { value: 0.15 + noise() * 0.2, attention: 0.25 },
      volatility: { value: noise() * 0.4, attention: 0.2 },
      atr: candles[index].close * 0.0045,
      memory: {
        score: clamp(s * 0.8, -1, 1),
        confidence: 0.55 + Math.abs(s) * 0.35
      }
    };
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log("=== Agent Core harsh smoke test ===\n");

const candles = makeSyntheticCandles(4000);
const sensorFn = makeDummySensorFn(candles);

console.log(`Bars: ${candles.length}`);
console.log(`Config risk_fraction: ${DEFAULT_CONFIG.risk_fraction}`);
console.log(`Config threshold / minTrust: ${DEFAULT_CONFIG.threshold} / ${DEFAULT_CONFIG.minTrust}\n`);

// Single full-period simulation
const result = simulate(candles, sensorFn, {
  starting_equity: 10_000,
  risk_fraction: 0.0075,
  allocation: 0.35,
  threshold: 0.12,   // looser for synthetic smoke test
  minTrust: 0.15
});

console.log("--- Full period ---");
console.log(`Final equity:   $${result.finalEquity.toFixed(2)}`);
console.log(`Max drawdown:   ${(result.maxDrawdown * 100).toFixed(2)}%`);
console.log(`Trades:         ${result.tradeCount}`);
console.log(`Win rate:       ${(result.winRate * 100).toFixed(1)}%`);
console.log(`Profit factor:  ${result.profitFactor === Infinity ? "Inf" : result.profitFactor.toFixed(2)}`);
console.log(`Net P&L:        $${(result.finalEquity - 10_000).toFixed(2)}\n`);

// Simple walk-forward (fixed agent, no optimisation yet)
const windows = [];
const step = 400;
const testLen = 300;
for (let start = 200; start + testLen < candles.length; start += step) {
  windows.push({
    trainStart: Math.max(0, start - 600),
    trainEnd: start - 1,
    testStart: start,
    testEnd: start + testLen - 1
  });
}

const wf = walkForward(candles, sensorFn, windows, {
  starting_equity: 10_000,
  threshold: 0.12,
  minTrust: 0.15
});
console.log("--- Walk-forward (fixed params) ---");
wf.forEach((w, i) => {
  console.log(
    `Window ${i + 1}: net ${(w.netReturn * 100).toFixed(2)}%  |  trades ${w.tradeCount}  |  DD ${(w.maxDrawdown * 100).toFixed(1)}%  |  WR ${(w.winRate * 100).toFixed(0)}%`
  );
});

const avgNet = wf.reduce((s, w) => s + w.netReturn, 0) / (wf.length || 1);
console.log(`\nAverage OOS net return per window: ${(avgNet * 100).toFixed(2)}%`);
console.log("\nSmoke test finished. Replace sensorFn with real analysis.states / retina / patternTrace next.");
