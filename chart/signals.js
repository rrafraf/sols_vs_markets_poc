"use strict";

import {
  closeChange,
  rsi,
  rsiAcceleration,
  rsiDivergence,
  rsiLevel
} from "./indicators.js";

// User-facing signal catalog.
//
// Object key = signal id used by strategy.js, e.g. market.sensors.rsi_divergence.
// name       = chart label.
// fn         = raw indicator/math function.
// from+calc  = compound signal built from other signals at matching candle times.
//
// Flat numeric fields such as period/lookback/smoothPeriod are passed to the
// indicator as options automatically. No repeated key/options wrapper needed.

export const signalSpecs = {
  rsi: {
    fn: rsi,
    name: "RSI 14",
    color: "#a371f7",
    pane: "separate",
    lineWidth: 1,
    period: 14
  },

  rsi_5_level: {
    fn: rsiLevel,
    name: "RSI 5 level",
    color: "#d2a8ff",
    pane: "separate",
    lineWidth: 1,
    period: 5
  },

  rsi_divergence: {
    fn: rsiDivergence,
    name: "RSI divergence",
    color: "#3fb950",
    pane: "separate",
    lineWidth: 1,
    period: 5,
    lookback: 8
  },

  rsi_acceleration: {
    fn: rsiAcceleration,
    name: "RSI acceleration",
    color: "#f0883e",
    pane: "separate",
    lineWidth: 1,
    period: 5,
    smoothPeriod: 2,
    normalizationWindow: 20,
    clipZ: 3
  },

  rsi_pressure: {
    from: ["rsi_5_level", "rsi_acceleration"],
    name: "RSI pressure",
    color: "#ff7b72",
    pane: "separate",
    lineWidth: 1,
    calc: ({ rsi_5_level: level, rsi_acceleration: acceleration }) => (
      0.65 * level + 0.35 * acceleration
    )
  },

  divergence_plus_acceleration: {
    from: ["rsi_divergence", "rsi_acceleration"],
    name: "Divergence + acceleration",
    color: "#ffa657",
    pane: "separate",
    lineWidth: 1,
    calc: ({ rsi_divergence: divergence, rsi_acceleration: acceleration }) => (
      divergence + acceleration
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
