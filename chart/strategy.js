"use strict";

// This is the user-facing strategy file.
// Edit `makeTradeCall(state)` to decide what the agent should do at the current candle.

export function makeTradeCall(state) {
  const signal = state.sensors.divergence_plus_acceleration?.value;
  const divergence = state.sensors.rsi_divergence?.value;
  const acceleration = state.sensors.rsi_acceleration?.value;

  if (signal == null || divergence == null || acceleration == null) {
    return wait("warming up divergence + acceleration");
  }

  if (signal > 0.6) {
    return long(`div+acc ${signal.toFixed(2)} = ${fmt(divergence)} + ${fmt(acceleration)}`);
  }

  if (signal < -0.6) {
    return short(`div+acc ${signal.toFixed(2)} = ${fmt(divergence)} + ${fmt(acceleration)}`);
  }

  return wait(`div+acc ${signal.toFixed(2)} = ${fmt(divergence)} + ${fmt(acceleration)}`);
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

function fmt(value) {
  return value.toFixed(2);
}
