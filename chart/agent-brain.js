"use strict";

import { rsi } from "./indicators.js";

export const agentSensors = [
  {
    key: "rsi",
    name: "RSI 14",
    color: "#a371f7",
    fn: rsi
  },
  {
    key: "close_change",
    name: "Close change",
    color: "#58a6ff",
    fn: closeChange
  }
];

export function buildDecisionFrame(index, bars, sensors = agentSensors) {
  const history = bars.slice(0, index + 1);
  const sensorValues = {};

  for (const sensor of sensors) {
    const series = normalizeSeries(sensor.fn(history, {
      key: sensor.key,
      name: sensor.name,
      options: sensor.options || {}
    }), history);
    const latest = lastPoint(series);
    sensorValues[sensor.key] = {
      key: sensor.key,
      name: sensor.name,
      value: latest?.value ?? null,
      point: latest,
      series
    };
  }

  return {
    index,
    bar: history.at(-1),
    history,
    sensors: sensorValues
  };
}

export function decide(frame) {
  // Edit this function to define the actual agent call.
  const rsiValue = frame.sensors.rsi?.value;
  const change = frame.sensors.close_change?.value;

  if (rsiValue == null || change == null) {
    return { action: "WAIT", reason: "warming up sensors", frame };
  }

  if (rsiValue < 30 && change > 0) {
    return {
      action: "LONG",
      reason: `RSI ${rsiValue.toFixed(1)} oversold + close turn ${pct(change)}`,
      frame
    };
  }

  if (rsiValue > 70 && change < 0) {
    return {
      action: "SHORT",
      reason: `RSI ${rsiValue.toFixed(1)} overbought + close turn ${pct(change)}`,
      frame
    };
  }

  return {
    action: "WAIT",
    reason: `RSI ${rsiValue.toFixed(1)}, close change ${pct(change)}`,
    frame
  };
}

function closeChange(bars) {
  return bars.map((bar, index) => {
    if (index === 0) return null;
    const prev = bars[index - 1].close;
    return {
      time: bar.time,
      value: (bar.close - prev) / prev
    };
  });
}

function normalizeSeries(raw, bars) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((point, index) => {
      if (point == null) return null;
      if (typeof point === "number") {
        return Number.isFinite(point) && bars[index]
          ? { time: bars[index].time, value: point }
          : null;
      }
      const value = point.value ?? point.score ?? point.signal ?? point.y;
      if (!Number.isFinite(value)) return null;
      return {
        ...point,
        time: point.time ?? bars[index]?.time,
        value
      };
    })
    .filter(point => point && point.time != null);
}

function lastPoint(series) {
  return series.length ? series[series.length - 1] : null;
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}
