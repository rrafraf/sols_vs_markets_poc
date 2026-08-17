# Current State

## Name

Hell Bench - a universal trading-idea lie detector.

## North Star

Build a fair judge for trading ideas before building a clever trader.

The project should make imported scripts, our own agents, coin-flip baselines, and future experiments comparable under the same replay, cost, slippage, latency, and robustness rules.

## Fidelity Rule

Approximate execution enough to catch self-deception. Do not chase HFT-grade market microstructure unless a candidate survives cheaper tests and earns deeper inspection.

Use high-frequency data as a microscope and torture chamber. Prefer 15m, 1h, and 4h as likely deployment test fields.

## Non-Negotiables

- No future leak or repainting.
- Costs and slippage are always counted.
- Dumb baselines are always compared.
- Weird execution cases stay visible in trace evidence.
- No candidate promotion without walk-forward or out-of-sample checks.
- User pressure is a signal, not proof; evidence decides the move.

## Current Scoreboard

| Check | Status | Note |
| --- | --- | --- |
| Same-candle entry/exit visible | PASS | `training_ground/reproduce-same-candle.js` reproduces and traces it. |
| Event lifecycle phases | PASS | Events now carry `phase`; manifest describes current execution model. |
| Trace evidence UI | PASS | Evidence mode renders same-candle cases and phase-tagged events. |
| TradingView/Pine intake | PARTIAL | Raw drop zone, note template, and helper exist; no real scripts translated yet. |
| Deterministic replay tests | TODO | Need same seed/same output checks. |
| Fee/slippage/PnL assertions | TODO | Need exact numeric unit tests. |
| Future-leak/repaint tests | TODO | Need candidate adapter checks. |
| 15m/1h/4h timeframe ladder | TODO | Need resampling and comparable runs. |
| Walk-forward gates in training ground | TODO | Older agent path has gates; new training ground needs them. |
| Universal candidate adapter | TODO | Needed to run our agent and imported solutions through the same bench. |

## Session Restart Ritual

Before serious work:

1. Read this file.
2. Read `docs/agent-board.json`.
3. Inspect the current Hell Bench or training-ground output.
4. State the project goal in one paragraph.
5. Claim one task with `node scripts/agent-board.js claim <task-id> --agent <name>`.
6. Work one failing or unknown scoreboard row.

If the session gets long, invisible, or repetitive:

1. Ask whether the work moved the scoreboard.
2. Ask whether it reduced uncertainty.
3. Ask whether it made future drift harder.
4. Stop adding cleverness unless a test or metric asks for it.

## Next Small Honest Move

Implement the `target-position-v1` CLI seam described in `D:\Documents\GitHub\_trading_sims\benchmark\MUNI_BRIDGE_CONTRACT.md`.

This lets `_trading_sims` compare `muni` against `reference_bar`, `backtrader`, `vectorbt`, and `pybroker` before any repo merge.

Use `docs/agent-board.json` as the coordination surface if multiple Codex tasks/subagents are active.
