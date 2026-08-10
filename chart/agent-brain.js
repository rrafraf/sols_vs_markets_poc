"use strict";

import { indicatorRegistry } from "./indicators.js";
import { makeTradeCall } from "./strategy.js";

const SENSOR_OPTION_KEYS = ["period", "lookback", "smoothPeriod", "normalizationWindow", "clipZ"];

const agentSensorSpecs = {
  rsi: "rsi",
  rsi_5_state: {
    use: "rsiLevel",
    name: "RSI 5 state",
    period: 5
  },
  rsi_divergence: {
    use: "rsiDivergence",
    period: 5,
    lookback: 8
  },
  rsi_acceleration: {
    use: "rsiAcceleration",
    period: 5,
    smoothPeriod: 2,
    normalizationWindow: 20,
    clipZ: 3
  },
  rsi_pressure: {
    from: ["rsi_5_state", "rsi_acceleration"],
    name: "RSI pressure",
    color: "#ff7b72",
    calc: ({ rsi_5_state: level, rsi_acceleration: acceleration }) => (
      0.65 * level + 0.35 * acceleration
    )
  },
  close_change: {
    fn: closeChange,
    name: "Close change",
    color: "#58a6ff",
    pane: "separate",
    lineWidth: 1
  }
};

export const agentSensors = resolveSensorSpecs(agentSensorSpecs);

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
  return normalizeDecision(makeTradeCall(frame), frame);
}

function normalizeDecision(decision, frame) {
  if (!decision || typeof decision !== "object") {
    return { action: "WAIT", reason: "strategy returned no decision", frame };
  }

  const action = String(decision.action || "WAIT").toUpperCase();
  return {
    ...decision,
    action: ["LONG", "SHORT", "WAIT"].includes(action) ? action : "WAIT",
    reason: decision.reason || action.toLowerCase(),
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

function resolveSensorSpecs(specs) {
  const resolved = new Map();
  const resolving = new Set();

  function resolve(key) {
    if (resolved.has(key)) return resolved.get(key);
    if (resolving.has(key)) throw new Error(`Circular sensor dependency: ${key}`);
    if (!(key in specs)) throw new Error(`Unknown sensor dependency: ${key}`);

    resolving.add(key);
    const sensor = resolveSensorSpec(key, specs[key], resolve);
    resolving.delete(key);
    resolved.set(key, sensor);
    return sensor;
  }

  return Object.keys(specs).map(resolve);
}

function resolveSensorSpec(key, spec, resolveDependency) {
  const normalizedSpec = typeof spec === "string" ? { use: spec } : spec;
  if (Array.isArray(normalizedSpec.from)) {
    return resolveCombinedSensorSpec(key, normalizedSpec, resolveDependency);
  }

  const fn = normalizedSpec.fn || indicatorRegistry[normalizedSpec.use];
  if (typeof fn !== "function") {
    throw new Error(`Unknown sensor indicator: ${normalizedSpec.use || key}`);
  }

  const meta = fn.indicator || {};
  return {
    ...meta,
    ...normalizedSpec,
    fn,
    key,
    name: normalizedSpec.name || meta.name || key,
    color: normalizedSpec.color || meta.color || "#58a6ff",
    pane: normalizedSpec.pane || meta.pane || "separate",
    lineWidth: normalizedSpec.lineWidth || meta.lineWidth || 1,
    options: {
      ...indicatorDefaultOptions(meta),
      ...sensorOptions(normalizedSpec)
    }
  };
}

function resolveCombinedSensorSpec(key, spec, resolveDependency) {
  const dependencies = spec.from.map(resolveDependency);
  if (typeof spec.calc !== "function") {
    throw new TypeError(`Combined sensor ${key} needs a calc function`);
  }

  return {
    ...spec,
    key,
    name: spec.name || key,
    color: spec.color || "#f0883e",
    pane: spec.pane || "separate",
    lineWidth: spec.lineWidth || 1,
    options: sensorOptions(spec),
    fn: (bars, context = {}) => combineSeries(bars, dependencies, spec.calc, {
      key,
      name: spec.name || key,
      options: context.options || {}
    })
  };
}

function combineSeries(bars, dependencies, calc, context) {
  const seriesByKey = Object.fromEntries(dependencies.map(sensor => [
    sensor.key,
    normalizeSeries(sensor.fn(bars, {
      key: sensor.key,
      name: sensor.name,
      options: sensor.options || {}
    }), bars)
  ]));
  const pointByKeyAndTime = Object.fromEntries(Object.entries(seriesByKey).map(([key, series]) => [
    key,
    new Map(series.map(point => [point.time, point]))
  ]));
  const out = [];

  for (const bar of bars) {
    const points = {};
    const values = {};
    let complete = true;

    for (const sensor of dependencies) {
      const point = pointByKeyAndTime[sensor.key].get(bar.time);
      if (!point || !Number.isFinite(point.value)) {
        complete = false;
        break;
      }
      points[sensor.key] = point;
      values[sensor.key] = point.value;
    }

    if (!complete) continue;

    const raw = calc(values, {
      ...context,
      bar,
      points,
      series: seriesByKey
    });
    const value = typeof raw === "number" ? raw : raw?.value;
    if (!Number.isFinite(value)) continue;

    out.push({
      ...(typeof raw === "object" ? raw : null),
      time: bar.time,
      value
    });
  }

  return out;
}

function indicatorDefaultOptions(meta) {
  const options = {};
  for (const key of SENSOR_OPTION_KEYS) {
    if (meta[key] != null) options[key] = meta[key];
  }
  return options;
}

function sensorOptions(spec) {
  const options = { ...(spec.options || {}) };
  for (const key of SENSOR_OPTION_KEYS) {
    if (spec[key] != null) options[key] = spec[key];
  }
  return options;
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
