/**
 * Deterministic reproduction for the same-candle entry/exit ambiguity.
 *
 * This is not a profitability test. It proves the current execution model can
 * enter a position on candle T and exit it on the same candle T when the candle's
 * OHLC range crosses the stop/take levels.
 */

"use strict";

const { runSimulation } = require("./run-experiment.js");

const candles = [
  candle(0, "2024-01-01T14:30:00Z", 100, 100.1, 99.9, 100),

  // The order from candle 0 fills at this candle's open. The same candle also
  // contains both stop-side and take-side prices for either LONG or SHORT.
  candle(1, "2024-01-01T14:31:00Z", 100, 101, 99, 100),

  candle(2, "2024-01-01T14:32:00Z", 100, 100.1, 99.9, 100),
  candle(3, "2024-01-01T14:33:00Z", 100, 100.1, 99.9, 100),
  candle(4, "2024-01-01T14:34:00Z", 100, 100.1, 99.9, 100)
];

const args = {
  agent: "coin-flip",
  seed: 1,
  tradeRate: 1,
  startingEquity: 10000,
  allocation: 0.25,
  stopBps: 45,
  takeBps: 70,
  maxHold: 18,
  minLatencyBars: 0,
  maxLatencyBars: 0,
  minSlippageBps: 0,
  maxSlippageBps: 0,
  missProbability: 0,
  trace: "summary,trades,events,decisions,anomalies",
  decisionTrace: "all",
  streamTrace: false
};

const result = runSimulation(candles, args, 0);
const sameCandle = result.anomalies.filter(a => a.type === "ENTRY_EXIT_SAME_CANDLE");
const intrabar = result.anomalies.filter(a => a.type === "INTRABAR_EXIT_AMBIGUITY");
const blocked = result.events.filter(e => e.type === "DECISION_BLOCKED");
const sameCandleTrades = result.trades.filter(t => t.entryIndex === t.exitIndex);
const orderAfterBlockedIndex = result.events.some((event, idx) => {
  if (event.type !== "DECISION_BLOCKED") return false;
  return result.events.slice(idx + 1).some(next =>
    next.index === event.index &&
    next.type === "ORDER_SUBMITTED"
  );
});

const report = {
  scenario: "entry-exit-same-candle",
  reproduced: sameCandle.length > 0 && sameCandleTrades.length > 0,
  sameCandleAnomalies: sameCandle.length,
  intrabarAmbiguities: intrabar.length,
  sameCandleTrades: sameCandleTrades.length,
  decisionBlockedEvents: blocked.length,
  orderSubmittedAfterBlockedSameIndex: orderAfterBlockedIndex,
  events: result.events.map(e => ({
    index: e.index,
    time: e.time,
    type: e.type,
    action: e.action,
    reason: e.reason,
    decisionIndex: e.decisionIndex,
    fillIndex: e.fillIndex
  })),
  anomalies: result.anomalies.map(a => ({
    index: a.index,
    time: a.time,
    type: a.type,
    message: a.message
  }))
};

console.log(JSON.stringify(report, null, 2));

if (!report.reproduced) {
  console.error("Expected ENTRY_EXIT_SAME_CANDLE reproduction, but it did not happen.");
  process.exit(1);
}

if (report.orderSubmittedAfterBlockedSameIndex) {
  console.error("A same-candle ORDER_SUBMITTED happened after DECISION_BLOCKED.");
  process.exit(1);
}

function candle(offset, isoTime, open, high, low, close) {
  return {
    isoTime,
    time: 1704119400 + offset * 60,
    open,
    high,
    low,
    close
  };
}
