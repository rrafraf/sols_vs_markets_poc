"use strict";

import { ACTION, cleanAction, isEntryAction } from "./actions.js";

// User-facing strategy file.
// Read: "decision at this market is this action".

const BASE_SIZE_EQUITY_FRACTION = 0.0025;
const MEMORY_HORIZON_BARS = 8;
const MEMORY_MIN_SAMPLES = 4;
const MEMORY_VETO_TRAUMA = 0.65;
const RISK_LOOKBACK_BARS = 60;

export function decisionAt(market) {
  const inputs = inputsAt(market);
  const desiredAction = desiredActionAt(inputs);
  const details = decisionDetails(market, desiredAction, inputs);

  if (hasMissingInput(inputs)) {
    return action(ACTION.HOLD, "warming up divergence / acceleration / RSI level", details);
  }

  if (isEntryAction(desiredAction) && details.memory.trauma >= MEMORY_VETO_TRAUMA) {
    return action(ACTION.WAIT, "memory veto: this setup has hurt before", {
      ...details,
      veto: "memory"
    });
  }

  if (isEntryAction(desiredAction) && details.drive.fear > details.drive.greed) {
    return action(ACTION.WAIT, "fear veto: setup exists, but fear beats greed", {
      ...details,
      veto: "fear"
    });
  }

  if (desiredAction === ACTION.LONG) {
    return action(ACTION.LONG, "bullish divergence + acceleration while RSI is low", details);
  }

  if (desiredAction === ACTION.SHORT) {
    return action(ACTION.SHORT, "bearish divergence + acceleration while RSI is high", details);
  }

  return action(ACTION.HOLD, "conditions not aligned", details);
}

export const makeTradeCall = decisionAt;

export function action(actionName, reason = cleanAction(actionName).toLowerCase(), details = {}) {
  const clean = cleanAction(actionName);
  const structured = isDecisionDetails(details);

  return {
    action: clean,
    reason,
    ...(structured ? details : { inputs: details })
  };
}

export function long(reason = "long", details = {}) {
  return action(ACTION.LONG, reason, details);
}

export function short(reason = "short", details = {}) {
  return action(ACTION.SHORT, reason, details);
}

export function hold(reason = "hold", details = {}) {
  return action(ACTION.HOLD, reason, details);
}

export function wait(reason = "wait", details = {}) {
  return action(ACTION.WAIT, reason, details);
}

function inputsAt(market) {
  return {
    divergence: market.sensors.rsi_divergence?.value,   // + bullish
    accel: market.sensors.rsi_acceleration?.value,      // + RSI curving up
    rsi: market.sensors.rsi_5_level?.value              // - low RSI, + high RSI
  };
}

function desiredActionAt(inputs) {
  if (hasMissingInput(inputs)) return ACTION.HOLD;
  if (inputs.divergence > 0 && inputs.accel > 0 && inputs.rsi < 0) return ACTION.LONG;
  if (inputs.divergence < 0 && inputs.accel < 0 && inputs.rsi > 0) return ACTION.SHORT;
  return ACTION.HOLD;
}

function decisionDetails(market, desiredAction, inputs) {
  const belief = beliefAt(inputs);
  const memory = memoryAt(market, desiredAction);
  const drive = driveAt(desiredAction, belief, memory);
  const risk = riskAt(market, desiredAction);
  const size = sizeAt(desiredAction, belief, drive, memory, risk);

  return {
    inputs,
    belief,
    drive,
    emotion: {
      conviction: belief.conviction,
      struggle: belief.struggle,
      uncertainty: belief.uncertainty,
      trauma: memory.trauma,
      greed: drive.greed,
      fear: drive.fear,
      joy: drive.joy,
      patience: drive.patience
    },
    memory,
    risk,
    size
  };
}

function beliefAt(inputs) {
  if (hasMissingInput(inputs)) {
    return {
      long: 0,
      short: 0,
      conviction: 0,
      conflict: 0,
      struggle: 0,
      uncertainty: 1
    };
  }

  const long = average([
    positive(inputs.divergence),
    positive(inputs.accel),
    positive(-inputs.rsi)
  ]);
  const short = average([
    positive(-inputs.divergence),
    positive(-inputs.accel),
    positive(inputs.rsi)
  ]);
  const conviction = Math.max(long, short);
  const conflict = Math.min(long, short);

  return {
    long,
    short,
    conviction,
    conflict,
    struggle: conviction > 0 ? clamp(conflict / conviction, 0, 1) : 0,
    uncertainty: clamp(1 - conviction, 0, 1)
  };
}

function memoryAt(market, desiredAction) {
  if (!isEntryAction(desiredAction)) {
    return {
      side: desiredAction,
      horizonBars: MEMORY_HORIZON_BARS,
      samples: 0,
      avgBps: 0,
      winRate: null,
      trauma: 0,
      comfort: 0,
      note: "no entry setup"
    };
  }

  const bars = market.history || [];
  const divergenceByTime = pointMap(market.sensors.rsi_divergence?.series);
  const accelByTime = pointMap(market.sensors.rsi_acceleration?.series);
  const rsiByTime = pointMap(market.sensors.rsi_5_level?.series);
  const outcomes = [];

  for (let i = 0; i < bars.length - MEMORY_HORIZON_BARS; i++) {
    const bar = bars[i];
    const future = bars[i + MEMORY_HORIZON_BARS];
    if (!bar || !future || !Number.isFinite(bar.close) || bar.close <= 0) continue;

    const pastInputs = {
      divergence: divergenceByTime.get(bar.time)?.value,
      accel: accelByTime.get(bar.time)?.value,
      rsi: rsiByTime.get(bar.time)?.value
    };
    if (desiredActionAt(pastInputs) !== desiredAction) continue;

    const rawReturn = (future.close - bar.close) / bar.close;
    const sideReturn = desiredAction === ACTION.LONG ? rawReturn : -rawReturn;
    outcomes.push(sideReturn * 10000);
  }

  if (!outcomes.length) {
    return {
      side: desiredAction,
      horizonBars: MEMORY_HORIZON_BARS,
      samples: 0,
      avgBps: 0,
      winRate: null,
      trauma: 0,
      comfort: 0,
      note: "no similar past setup in current history"
    };
  }

  const avgBps = average(outcomes);
  const winRate = outcomes.filter(value => value > 0).length / outcomes.length;
  const enoughSamples = outcomes.length >= MEMORY_MIN_SAMPLES;

  return {
    side: desiredAction,
    horizonBars: MEMORY_HORIZON_BARS,
    samples: outcomes.length,
    avgBps,
    winRate,
    trauma: enoughSamples && avgBps < 0 ? clamp(-avgBps / 80, 0, 1) : 0,
    comfort: enoughSamples && avgBps > 0 ? clamp(avgBps / 80, 0, 1) : 0,
    note: enoughSamples ? "past setup sample available" : "too few similar past setups"
  };
}

function driveAt(desiredAction, belief, memory) {
  const sideBelief = desiredAction === ACTION.LONG
    ? belief.long
    : desiredAction === ACTION.SHORT
    ? belief.short
    : 0;
  const greed = isEntryAction(desiredAction)
    ? clamp(sideBelief + 0.35 * memory.comfort, 0, 1)
    : 0;
  const fear = clamp(0.45 * belief.uncertainty + 0.35 * belief.struggle + 0.55 * memory.trauma, 0, 1);
  const joy = clamp(memory.comfort, 0, 1);
  const patience = desiredAction === ACTION.HOLD
    ? clamp(0.7 + 0.3 * belief.uncertainty, 0, 1)
    : clamp(0.5 * belief.uncertainty + 0.4 * belief.struggle + 0.6 * memory.trauma, 0, 1);

  return {
    greed,
    fear,
    joy,
    patience,
    dominant: dominantDrive({ greed, fear, joy, patience })
  };
}

function riskAt(market, desiredAction) {
  if (!isEntryAction(desiredAction)) {
    return {
      side: desiredAction,
      lookbackBars: RISK_LOOKBACK_BARS,
      samples: 0,
      expectedAdverseBps: 0,
      worstAdverseBps: 0,
      severity: 0,
      reason: "no entry action, no wrong-way trade risk"
    };
  }

  const bars = (market.history || []).slice(-RISK_LOOKBACK_BARS - MEMORY_HORIZON_BARS);
  const adverseMoves = [];

  for (let i = 0; i < bars.length - MEMORY_HORIZON_BARS; i++) {
    const bar = bars[i];
    const future = bars[i + MEMORY_HORIZON_BARS];
    if (!bar || !future || !Number.isFinite(bar.close) || bar.close <= 0) continue;

    const rawReturn = (future.close - bar.close) / bar.close;
    const sideReturn = desiredAction === ACTION.LONG ? rawReturn : -rawReturn;
    if (sideReturn < 0) adverseMoves.push(-sideReturn * 10000);
  }

  if (!adverseMoves.length) {
    return {
      side: desiredAction,
      lookbackBars: RISK_LOOKBACK_BARS,
      samples: 0,
      expectedAdverseBps: 0,
      worstAdverseBps: 0,
      severity: 0,
      reason: "no recent adverse move sample"
    };
  }

  const expectedAdverseBps = average(adverseMoves);
  const worstAdverseBps = Math.max(...adverseMoves);

  return {
    side: desiredAction,
    lookbackBars: RISK_LOOKBACK_BARS,
    samples: adverseMoves.length,
    expectedAdverseBps,
    worstAdverseBps,
    severity: clamp(worstAdverseBps / 160, 0, 1),
    reason: "recent wrong-way move size if this action is wrong"
  };
}

function sizeAt(desiredAction, belief, drive, memory, risk) {
  if (!isEntryAction(desiredAction)) {
    return {
      equityFraction: 0,
      baseEquityFraction: BASE_SIZE_EQUITY_FRACTION,
      conviction: 0,
      reason: "no entry action"
    };
  }

  const sideBelief = desiredAction === ACTION.LONG ? belief.long : belief.short;
  const traumaPenalty = 1 - memory.trauma;
  const strugglePenalty = 1 - 0.5 * belief.struggle;
  const fearPenalty = 1 - 0.35 * drive.fear;
  const riskPenalty = 1 - 0.5 * risk.severity;
  const conviction = clamp(sideBelief * traumaPenalty * strugglePenalty * fearPenalty * riskPenalty, 0, 1);

  return {
    equityFraction: BASE_SIZE_EQUITY_FRACTION * conviction,
    baseEquityFraction: BASE_SIZE_EQUITY_FRACTION,
    conviction,
    reason: "base size scaled by belief, fear, struggle, memory trauma, and wrong-way risk"
  };
}

function isDecisionDetails(value) {
  return value && typeof value === "object" && (
    "inputs" in value ||
    "belief" in value ||
    "drive" in value ||
    "emotion" in value ||
    "memory" in value ||
    "risk" in value ||
    "size" in value ||
    "veto" in value
  );
}

function hasMissingInput(inputs) {
  return Object.values(inputs).some(value => value == null);
}

function pointMap(series) {
  return new Map((series || []).map(point => [point.time, point]));
}

function positive(value) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function dominantDrive(drives) {
  return Object.entries(drives)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "none";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
