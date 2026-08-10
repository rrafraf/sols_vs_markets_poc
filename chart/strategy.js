"use strict";

// This is the user-facing strategy file.
// Edit `makeTradeCall(state)` to decide what the agent should do at the current candle.

export function makeTradeCall(state) {
  const rsiValue = state.sensors.rsi?.value;
  const change = state.sensors.close_change?.value;

  if (rsiValue == null || change == null) {
    return wait("warming up sensors");
  }

  if (rsiValue < 30 && change > 0) {
    return long(`RSI ${rsiValue.toFixed(1)} oversold + close turn ${pct(change)}`);
  }

  if (rsiValue > 70 && change < 0) {
    return short(`RSI ${rsiValue.toFixed(1)} overbought + close turn ${pct(change)}`);
  }

  return wait(`RSI ${rsiValue.toFixed(1)}, close change ${pct(change)}`);
}

export function long(reason = "long") {
  return { action: "LONG", reason };
}

export function short(reason = "short") {
  return { action: "SHORT", reason };
}

export function wait(reason = "wait") {
  return { action: "WAIT", reason };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}
