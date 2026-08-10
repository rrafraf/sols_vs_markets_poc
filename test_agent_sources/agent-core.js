/**
 * agent-core.js
 * Minimal causal trading agent extracted from the research lab.
 * Pure functions only. No DOM, no adaptive online weights, no UI.
 *
 * Design goals for first production candidate:
 * - Fully deterministic given the same inputs
 * - Explicit costs (fee + slippage)
 * - Hard risk limits that cannot be overridden
 * - Easy to walk-forward / Monte-Carlo / paper-trade
 *
 * REMOVE AT WILL: adaptive weight learning, multi-team, physics online calibration,
 * pattern-memory nearest-neighbour voting, companion authority scoring, retina heatmaps.
 * Those can return later once this thin core survives harsh tests.
 */

"use strict";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

/** Default risk & cost config. Override via constructor or setConfig. */
const DEFAULT_CONFIG = {
  // Costs (applied on every fill)
  fee_rate: 0.0005,          // 5 bps per side
  slippage_rate: 0.0005,     // 5 bps

  // Position sizing
  risk_fraction: 0.0075,     // 0.75 % of equity risked per trade
  allocation: 0.40,          // max notional fraction of equity
  cash_cap: 0.95,            // never use more than this of free cash

  // Entry filters (Bloodhound-style)
  threshold: 0.22,           // |score| must exceed this
  minTrust: 0.28,            // average attention / confidence
  cooldown_bars: 6,

  // Exit rules
  stopAtr: 1.10,
  takeAtr: 1.60,
  maxHold: 24,               // bars
  trailing_stop_atr: 1.80,

  // Hard portfolio limits
  max_trades_per_session: 2,
  max_daily_loss_fraction: 0.025,  // pause agent if daily loss exceeds this
  starting_equity: 10_000,

  // Warm-up
  warmup_bars: 180
};

/**
 * Simple fixed-weight opinion (no online learning).
 * Inputs are already-computed sensor values in [-1, +1] range.
 */
function opinion(sensors, cfg = DEFAULT_CONFIG) {
  // Fixed weights – deliberately simple and inspectable.
  // geometry + motion + momentum carry most of the directional load.
  const weights = {
    geometry: 0.28,
    motion: 0.30,
    momentum: 0.22,
    pressure: 0.10,
    regime: 0.05,
    volatility: 0.05
  };

  let score = 0;
  let attention = 0;
  let totalW = 0;

  for (const [key, w] of Object.entries(weights)) {
    const s = sensors[key];
    if (!s || !Number.isFinite(s.value)) continue;
    score += s.value * w;
    attention += (s.attention ?? Math.abs(s.value)) * w;
    totalW += w;
  }

  // Optional memory / pattern contribution (if provided)
  if (sensors.memory && Number.isFinite(sensors.memory.score)) {
    const mw = 0.18;
    score += sensors.memory.score * mw;
    attention += (sensors.memory.confidence ?? 0.5) * mw;
    totalW += mw;
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

/**
 * Pure simulation engine.
 * candles: array of { time, open, high, low, close, isoTime? }
 * sensorFn: (index) => { geometry, motion, momentum, ... , memory? }
 *   each lens: { value: number in [-1,1], attention?: number in [0,1] }
 */
function simulate(candles, sensorFn, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  let equity = cfg.starting_equity;
  let peak = equity;
  let maxDrawdown = 0;
  let position = null;
  let pending = null;
  let cooldownUntil = 0;
  let dailyStartEquity = equity;
  let currentSession = null;
  let sessionTrades = 0;
  let paused = false;

  const trades = [];
  const equityCurve = [];
  const events = [];

  const closePosition = (index, rawPrice, reason) => {
    if (!position) return;
    const sideSign = position.side === "LONG" ? 1 : -1;
    const exit =
      rawPrice *
      (position.side === "LONG" ? 1 - cfg.slippage_rate : 1 + cfg.slippage_rate);
    const gross =
      position.notional * ((exit - position.entry) / position.entry) * sideSign;
    const fee = position.notional * cfg.fee_rate;
    const pnl = gross - fee;
    equity += pnl;

    const trade = {
      entryIndex: position.entryIndex,
      exitIndex: index,
      side: position.side,
      entry: position.entry,
      exit,
      notional: position.notional,
      pnl,
      reason,
      barsHeld: index - position.entryIndex
    };
    trades.push(trade);
    events.push({ type: "EXIT", index, ...trade });

    position = null;
    pending = null;
    cooldownUntil = index + cfg.cooldown_bars;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const session = bar.isoTime ? bar.isoTime.slice(0, 10) : String(Math.floor(i / 390));

    // New session reset
    if (session !== currentSession) {
      currentSession = session;
      sessionTrades = 0;
      dailyStartEquity = equity;
      paused = false;
    }

    // Daily loss circuit breaker
    if ((dailyStartEquity - equity) / dailyStartEquity >= cfg.max_daily_loss_fraction) {
      paused = true;
    }

    // Execute pending entry on this bar's open (causal)
    if (pending && pending.executeIndex === i && !position && !paused) {
      const side = pending.side;
      const entry =
        bar.open * (side === "LONG" ? 1 + cfg.slippage_rate : 1 - cfg.slippage_rate);
      const riskDollars = equity * cfg.risk_fraction;
      const stopDist = Math.max(pending.atr * cfg.stopAtr, entry * 0.002);
      const qtyByRisk = riskDollars / stopDist;
      const notionalByAlloc = equity * cfg.allocation;
      const notionalByCash = equity * cfg.cash_cap;
      const notional = Math.min(
        notionalByAlloc,
        notionalByCash,
        qtyByRisk * entry
      );
      const quantity = notional / entry;

      if (quantity > 0 && notional > 10) {
        const fee = notional * cfg.fee_rate;
        equity -= fee;
        position = {
          side,
          entry,
          notional,
          quantity,
          entryIndex: i,
          atr: pending.atr,
          stop:
            side === "LONG"
              ? entry - stopDist
              : entry + stopDist,
          target:
            side === "LONG"
              ? entry + pending.atr * cfg.takeAtr
              : entry - pending.atr * cfg.takeAtr,
          highest: bar.close,
          lowest: bar.close
        };
        sessionTrades += 1;
        events.push({
          type: "ENTRY",
          index: i,
          side,
          price: entry,
          notional,
          quantity
        });
      }
      pending = null;
    }

    // Manage open position
    if (position) {
      // Gap / stop / target on this bar
      let exitPrice = null;
      let reason = null;

      if (position.side === "LONG") {
        if (bar.open <= position.stop) {
          exitPrice = bar.open;
          reason = "gap-stop";
        } else if (bar.low <= position.stop) {
          exitPrice = position.stop;
          reason = "stop";
        } else if (bar.high >= position.target) {
          exitPrice = position.target;
          reason = "target";
        }
      } else {
        if (bar.open >= position.stop) {
          exitPrice = bar.open;
          reason = "gap-stop";
        } else if (bar.high >= position.stop) {
          exitPrice = position.stop;
          reason = "stop";
        } else if (bar.low <= position.target) {
          exitPrice = position.target;
          reason = "target";
        }
      }

      if (exitPrice != null) {
        closePosition(i, exitPrice, reason);
      } else {
        // Trailing + time / flip exit
        position.highest = Math.max(position.highest, bar.close);
        position.lowest = Math.min(position.lowest, bar.close);

        if (position.side === "LONG") {
          const trail = position.highest - position.atr * cfg.trailing_stop_atr;
          position.stop = Math.max(position.stop, trail);
        } else {
          const trail = position.lowest + position.atr * cfg.trailing_stop_atr;
          position.stop = Math.min(position.stop, trail);
        }

        const held = i - position.entryIndex;
        const sensors = sensorFn(i);
        const op = opinion(sensors, cfg);
        const flipped =
          (position.side === "LONG" && op.score < -0.15) ||
          (position.side === "SHORT" && op.score > 0.15);

        if (flipped || held >= cfg.maxHold) {
          closePosition(i, bar.close, flipped ? "flip" : "time");
        }
      }
    }

    // New signal (decision on this bar, fill next open)
    if (
      i >= cfg.warmup_bars &&
      !position &&
      !pending &&
      i >= cooldownUntil &&
      !paused &&
      sessionTrades < cfg.max_trades_per_session &&
      i < candles.length - 1
    ) {
      const sensors = sensorFn(i);
      const op = opinion(sensors, cfg);
      if (op.call !== "WAIT") {
        // crude ATR proxy from recent high-low if not supplied
        const atr =
          sensors.atr ??
          Math.max(
            ...candles
              .slice(Math.max(0, i - 14), i + 1)
              .map((b) => b.high - b.low),
            candles[i].close * 0.004
          );
        pending = {
          side: op.call,
          executeIndex: i + 1,
          atr,
          decisionIndex: i,
          score: op.score,
          trust: op.trust
        };
        events.push({
          type: "QUEUED",
          index: i,
          side: op.call,
          score: op.score,
          trust: op.trust
        });
      }
    }

    // Mark-to-market equity
    let mtm = equity;
    if (position) {
      const sideSign = position.side === "LONG" ? 1 : -1;
      mtm +=
        position.notional *
        ((bar.close - position.entry) / position.entry) *
        sideSign;
    }
    peak = Math.max(peak, mtm);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - mtm) / peak : 0);
    equityCurve.push({ index: i, equity: mtm, cash: equity });
  }

  // Force close any leftover
  if (position) {
    closePosition(candles.length - 1, candles[candles.length - 1].close, "end");
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0)
  );

  return {
    finalEquity: equity,
    maxDrawdown,
    trades,
    events,
    equityCurve,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    tradeCount: trades.length,
    config: cfg
  };
}

/**
 * Very lightweight walk-forward helper.
 * windows: array of { trainStart, trainEnd, testStart, testEnd }
 * For each window we just run the fixed agent (no optimisation yet).
 * Later you can add parameter search inside the train window.
 */
function walkForward(candles, sensorFn, windows, userConfig = {}) {
  return windows.map((w) => {
    const testBars = candles.slice(w.testStart, w.testEnd + 1);
    // sensorFn must be able to answer relative to the sliced array or absolute indices.
    // For simplicity we pass absolute indices and require the caller to handle it.
    const result = simulate(testBars, (localIdx) => sensorFn(w.testStart + localIdx), userConfig);
    return {
      ...w,
      ...result,
      netReturn: (result.finalEquity - (userConfig.starting_equity ?? DEFAULT_CONFIG.starting_equity)) /
        (userConfig.starting_equity ?? DEFAULT_CONFIG.starting_equity)
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
module.exports = {
  DEFAULT_CONFIG,
  opinion,
  simulate,
  walkForward,
  clamp,
  mean
};

// Browser global if needed
if (typeof window !== "undefined") {
  window.AgentCore = module.exports;
}
