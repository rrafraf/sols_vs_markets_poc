"use strict";

const { DEFAULT_CONFIG } = require("./config.js");
const { opinion } = require("./policy.js");

function causalAtr(candles, index, lookback = 14) {
  const start = Math.max(0, index - lookback + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= index; i++) {
    const bar = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : bar.open;
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose)
    );
    if (Number.isFinite(tr)) {
      sum += tr;
      count += 1;
    }
  }
  return count ? sum / count : candles[index].close * 0.004;
}

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

  function closePosition(index, rawPrice, reason) {
    if (!position) return;
    const sideSign = position.side === "LONG" ? 1 : -1;
    const exit = rawPrice * (position.side === "LONG" ? 1 - cfg.slippage_rate : 1 + cfg.slippage_rate);
    const gross = position.notional * ((exit - position.entry) / position.entry) * sideSign;
    const exitFee = position.notional * cfg.fee_rate;
    const netTradePnl = gross - position.entryFee - exitFee;

    // Entry fee was already debited at entry, so only gross - exit fee changes account equity now.
    equity += gross - exitFee;

    const trade = {
      entryIndex: position.entryIndex,
      exitIndex: index,
      side: position.side,
      entry: position.entry,
      exit,
      notional: position.notional,
      entryFee: position.entryFee,
      exitFee,
      grossPnl: gross,
      pnl: netTradePnl,
      reason,
      barsHeld: index - position.entryIndex
    };
    trades.push(trade);
    events.push({ type: "EXIT", index, ...trade });

    position = null;
    pending = null;
    cooldownUntil = index + cfg.cooldown_bars;
  }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const session = bar.isoTime ? bar.isoTime.slice(0, 10) : String(Math.floor(i / 390));

    if (session !== currentSession) {
      currentSession = session;
      sessionTrades = 0;
      dailyStartEquity = equity;
      paused = false;
    }

    if ((dailyStartEquity - equity) / dailyStartEquity >= cfg.max_daily_loss_fraction) {
      paused = true;
    }

    // A decision made on bar i-1 is filled at bar i open.
    if (pending && pending.executeIndex === i && !position && !paused) {
      const side = pending.side;
      const entry = bar.open * (side === "LONG" ? 1 + cfg.slippage_rate : 1 - cfg.slippage_rate);
      const riskDollars = equity * cfg.risk_fraction;
      const stopDist = Math.max(pending.atr * cfg.stopAtr, entry * 0.002);
      const qtyByRisk = riskDollars / stopDist;
      const notional = Math.min(equity * cfg.allocation, equity * cfg.cash_cap, qtyByRisk * entry);
      const quantity = notional / entry;

      if (quantity > 0 && notional > 10) {
        const entryFee = notional * cfg.fee_rate;
        equity -= entryFee;
        position = {
          side,
          entry,
          notional,
          quantity,
          entryFee,
          atr: pending.atr,
          entryIndex: i,
          stop: side === "LONG" ? entry - stopDist : entry + stopDist,
          target: side === "LONG" ? entry + pending.atr * cfg.takeAtr : entry - pending.atr * cfg.takeAtr,
          highest: bar.open,
          lowest: bar.open
        };
        sessionTrades += 1;
        events.push({ type: "ENTRY", index: i, side, price: entry, notional, quantity, entryFee });
      }
      pending = null;
    }

    if (position) {
      let exitPrice = null;
      let reason = null;

      // Conservative OHLC ambiguity rule: if both stop and target could have been touched,
      // stop is checked first because intrabar path is unknown.
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
        position.highest = Math.max(position.highest, bar.high);
        position.lowest = Math.min(position.lowest, bar.low);

        if (position.side === "LONG") {
          position.stop = Math.max(position.stop, position.highest - position.atr * cfg.trailing_stop_atr);
        } else {
          position.stop = Math.min(position.stop, position.lowest + position.atr * cfg.trailing_stop_atr);
        }

        const held = i - position.entryIndex;
        const op = opinion(sensorFn(i), cfg);
        const flipped =
          (position.side === "LONG" && op.score < -0.15) ||
          (position.side === "SHORT" && op.score > 0.15);

        if (flipped || held >= cfg.maxHold) {
          closePosition(i, bar.close, flipped ? "flip" : "time");
        }
      }
    }

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
      events.push({ type: "DECISION", index: i, call: op.call, score: op.score, trust: op.trust });

      if (op.call !== "WAIT") {
        const atr = Number.isFinite(sensors.atr) ? sensors.atr : causalAtr(candles, i, 14);
        pending = {
          side: op.call,
          executeIndex: i + 1,
          atr,
          decisionIndex: i,
          score: op.score,
          trust: op.trust
        };
        events.push({ type: "QUEUED", index: i, side: op.call, score: op.score, trust: op.trust });
      }
    }

    let mtm = equity;
    if (position) {
      const sideSign = position.side === "LONG" ? 1 : -1;
      mtm += position.notional * ((bar.close - position.entry) / position.entry) * sideSign;
    }
    peak = Math.max(peak, mtm);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - mtm) / peak : 0);
    equityCurve.push({ index: i, equity: mtm, cash: equity });
  }

  if (position && candles.length) {
    closePosition(candles.length - 1, candles[candles.length - 1].close, "end");
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const totalFees = trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0);

  return {
    finalEquity: equity,
    netReturn: cfg.starting_equity ? (equity - cfg.starting_equity) / cfg.starting_equity : 0,
    maxDrawdown,
    trades,
    events,
    equityCurve,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    tradeCount: trades.length,
    totalFees,
    config: cfg
  };
}

module.exports = { simulate, causalAtr };
