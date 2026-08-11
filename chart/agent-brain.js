"use strict";

import { cleanAction } from "./actions.js";
import { signalSpecs } from "./signals.js";
import { decisionAt } from "./strategy.js";

const SPEC_RUNTIME_KEYS = new Set([
  "fn",
  "from",
  "calc",
  "name",
  "color",
  "pane",
  "lineWidth",
  "seriesType",
  "priceScaleId",
  "lastValueVisible",
  "priceLineVisible",
  "options"
]);

export const agentSensors = resolveSensorSpecs(signalSpecs);

// Convert chart history at one candle into the moment that strategy reads:
// chart location + current sensor vibe. Trading intent stays in strategy.js.
export function momentAt(index, bars, sensors = agentSensors) {
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

export const marketAt = momentAt;

export function decide(moment) {
  const decision = decisionAt(moment);
  return decisionWithMoment(decision, moment);
}

function decisionWithMoment(decision, moment) {
  if (decision == null || typeof decision !== "object") {
    return { action: cleanAction(), reason: "strategy returned no decision", moment };
  }

  return {
    ...decision,
    action: cleanAction(decision.action),
    reason: decision.reason || cleanAction(decision.action).toLowerCase(),
    moment
  };
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
  if (Array.isArray(spec.from)) {
    return resolveCombinedSensorSpec(key, spec, resolveDependency);
  }

  if (typeof spec.fn !== "function") {
    throw new TypeError(`Signal ${key} needs an fn function`);
  }

  return {
    ...spec,
    key,
    name: spec.name || key,
    color: spec.color || "#58a6ff",
    pane: spec.pane || "separate",
    lineWidth: spec.lineWidth || 1,
    options: signalOptions(spec)
  };
}

function resolveCombinedSensorSpec(key, spec, resolveDependency) {
  const dependencies = spec.from.map(resolveDependency);
  if (typeof spec.calc !== "function") {
    throw new TypeError(`Combined signal ${key} needs a calc function`);
  }

  return {
    ...spec,
    key,
    name: spec.name || key,
    color: spec.color || "#f0883e",
    pane: spec.pane || "separate",
    lineWidth: spec.lineWidth || 1,
    options: signalOptions(spec),
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

function signalOptions(spec) {
  const options = { ...(spec.options || {}) };
  for (const [key, value] of Object.entries(spec)) {
    if (SPEC_RUNTIME_KEYS.has(key) || value == null) continue;
    if (typeof value === "function" || typeof value === "object") continue;
    options[key] = value;
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
