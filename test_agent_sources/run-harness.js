"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_CONFIG } = require("./core/config.js");
const { simulate } = require("./core/simulator.js");
const { makeSyntheticCandles, makeDummySensorFn } = require("./core/synthetic.js");
const { renderRunSvg } = require("./render-run-svg.js");

/**
 * WHAT: deterministic smoke experiment for the fixed policy + simulator.
 * WHY: verify causality, event generation, accounting and reproducibility before
 *      connecting real market data or adding any training/search loop.
 * WHEN: run after changing policy/simulator code; same seed + config should
 *       reproduce the same result.
 *
 * This is NOT training and NOT evidence of market edge.
 */
const experiment = {
  name: "agent-core-deterministic-smoke",
  seed: Number(process.env.AGENT_SEED || 12345),
  sensorSeed: Number(process.env.AGENT_SENSOR_SEED || 67890),
  bars: Number(process.env.AGENT_BARS || 4000),
  config: {
    ...DEFAULT_CONFIG,
    starting_equity: 10_000,
    allocation: 0.35,
    threshold: 0.12,
    minTrust: 0.15
  }
};

const candles = makeSyntheticCandles({ n: experiment.bars, seed: experiment.seed });
const sensorFn = makeDummySensorFn(candles, experiment.sensorSeed);
const result = simulate(candles, sensorFn, experiment.config);

const payload = {
  meta: {
    experiment: experiment.name,
    purpose: "smoke-test fixed policy and simulator; no learning",
    seed: experiment.seed,
    sensorSeed: experiment.sensorSeed,
    bars: experiment.bars,
    generatedAt: new Date().toISOString()
  },
  config: experiment.config,
  candles,
  result
};

const outDir = path.resolve(__dirname, "..", "output");
fs.mkdirSync(outDir, { recursive: true });
const stem = `${experiment.name}-seed-${experiment.seed}-${experiment.sensorSeed}`;
const jsonPath = path.join(outDir, `${stem}.json`);
const svgPath = path.join(outDir, `${stem}.svg`);

fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
renderRunSvg(payload, svgPath);

console.log("=== Agent core deterministic smoke test ===");
console.log(`seed:            ${experiment.seed}`);
console.log(`sensor seed:     ${experiment.sensorSeed}`);
console.log(`bars:            ${candles.length}`);
console.log(`trades:          ${result.tradeCount}`);
console.log(`final equity:    $${result.finalEquity.toFixed(2)}`);
console.log(`net return:      ${(result.netReturn * 100).toFixed(2)}%`);
console.log(`max drawdown:    ${(result.maxDrawdown * 100).toFixed(2)}%`);
console.log(`win rate:        ${(result.winRate * 100).toFixed(1)}%`);
console.log(`total fees:      $${result.totalFees.toFixed(2)}`);
console.log(`run JSON:        ${jsonPath}`);
console.log(`visual timeline: ${svgPath}`);
console.log("NOTE: synthetic smoke test only; this does not train the agent.");
