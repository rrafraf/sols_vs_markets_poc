"use strict";

const DEFAULT_CONFIG = Object.freeze({
  fee_rate: 0.0005,
  slippage_rate: 0.0005,

  risk_fraction: 0.0075,
  allocation: 0.40,
  cash_cap: 0.95,

  threshold: 0.22,
  minTrust: 0.28,
  cooldown_bars: 6,

  stopAtr: 1.10,
  takeAtr: 1.60,
  maxHold: 24,
  trailing_stop_atr: 1.80,

  max_trades_per_session: 2,
  max_daily_loss_fraction: 0.025,
  starting_equity: 10_000,
  warmup_bars: 180
});

const POLICY_WEIGHTS = Object.freeze({
  geometry: 0.28,
  motion: 0.30,
  momentum: 0.22,
  pressure: 0.10,
  regime: 0.05,
  volatility: 0.05
});

const MEMORY_WEIGHT = 0.18;

module.exports = { DEFAULT_CONFIG, POLICY_WEIGHTS, MEMORY_WEIGHT };
