"use strict";

const { POLICY_WEIGHTS, MEMORY_WEIGHT } = require("./config.js");

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function opinion(sensors, cfg) {
  let score = 0;
  let attention = 0;
  let totalW = 0;

  for (const [key, weight] of Object.entries(POLICY_WEIGHTS)) {
    const sensor = sensors[key];
    if (!sensor || !Number.isFinite(sensor.value)) continue;
    score += sensor.value * weight;
    attention += (sensor.attention ?? Math.abs(sensor.value)) * weight;
    totalW += weight;
  }

  if (sensors.memory && Number.isFinite(sensors.memory.score)) {
    score += sensors.memory.score * MEMORY_WEIGHT;
    attention += (sensors.memory.confidence ?? 0.5) * MEMORY_WEIGHT;
    totalW += MEMORY_WEIGHT;
  }

  score = totalW ? clamp(score / totalW, -1, 1) : 0;
  const trust = totalW ? clamp(attention / totalW, 0, 1) : 0;

  const call =
    trust < cfg.minTrust || Math.abs(score) < cfg.threshold
      ? "WAIT"
      : score > 0
        ? "LONG"
        : "SHORT";

  return { score, trust, call };
}

module.exports = { opinion, clamp };
