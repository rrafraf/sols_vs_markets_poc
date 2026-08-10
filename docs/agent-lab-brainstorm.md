# Agent Lab Brainstorm

This file is the shared scratchpad for Codex, ChatGPT, and human notes about the trading-agent work.

## Current Local Facts

- `test_agent_sources/agent-core.js` is the actual engine: pure CommonJS, no DOM, exports `simulate`, `walkForward`, `opinion`, and `DEFAULT_CONFIG`.
- `test_agent_sources/test-agent-core.js` is only a synthetic smoke test. It proves the engine runs, but it does not prove a trading edge.
- `data/market.db` contains real TSLA candles, including `1Min` data from `2020-07-27T13:30:00Z` through `2024-12-31T20:59:00Z`.
- The browser app currently has an empty `chart/agent.js`; it does not call `agent-core.js` yet.
- The useful integration boundary is: candles + causal sensor function -> `simulate()` -> trades/events/equity curve -> visualization.

## How To Grind Locally

Run a small real-data batch:

```powershell
node test_agent_sources\grind-agent-core.js --runs 16 --workers 4 --limit 30000
```

Run a larger batch:

```powershell
node test_agent_sources\grind-agent-core.js --runs 200 --workers 4 --from 2022-01-01 --to 2024-12-31 --limit 200000
```

Outputs:

- `output/agent-grind-summary.json`: all run summaries plus best/worst config.
- `output/agent-grind-best-trades.json`: trade-by-trade explanations for the best run.
- `output/agent-grind-report.md`: readable status report with `RUN_CANDIDATE`, `WATCH_ONLY`, or `NO_GO`.
- `output/agent-run-candidate.json`: machine-readable candidate config and verdict.

Create a report after a grind:

```powershell
node test_agent_sources\report-agent-grind.js
```

## GitHub Visibility

The workflow `.github/workflows/agent-grind.yml` runs the smoke test, attempts a real grind, publishes a Markdown job summary, and uploads grind artifacts.

Important: `data/market.db` is ignored locally and is not present on a normal GitHub-hosted runner. Without that DB the workflow reports `NO_DATA` and skips the real grind. For real periodic GitHub reports, use a self-hosted runner that has `data/market.db`, or add an explicit data restore/fetch step.

## What We Should Expect

- The synthetic harness should be noisy. Green synthetic results are not evidence.
- Real-data results can be overfit because the runner searches config space.
- The first credible milestone is not max profit. It is stable behavior across time slices with costs, slippage, max daily loss, and few unexplained trades.
- A good explanation record should show: decision time, side, score, trust, strongest sensor inputs, entry/exit, PnL, and exit reason.

## Next Engineering Step

Connect the browser to saved grind output first, not live optimization:

1. Add an API route for `output/agent-grind-best-trades.json`.
2. Draw entry/exit markers on the existing chart.
3. Show the decision object next to the selected candle.
4. Only after that, decide whether the browser should call the engine live.

## Open Questions

- Do we keep the current simple OHLC-derived sensor, or port the older research-lab sensor pieces one by one?
- Should config search be random, grid, walk-forward, or Bayesian later?
- What metric blocks a config from being considered? Candidate: minimum trades, max drawdown, positive OOS average, no single-window dependency.

## Current Consensus To Review

- Keep the tester/grinder. Its main value is honesty: it should be able to say `NO_GO` clearly instead of producing a flattering fake edge.
- Keep the harsh edge-condition checks from `test-agent-core.js`; this is the part that protects us from trusting code that only works on the happy path.
- Do not throw away the older metric/probability ideas wholesale. Some of those computed signals may be useful if they can be separated, named, visualized, and judged one at a time.
- The probability layer should become observable: at each candle, show the proposed probability/odds, what inputs raised or lowered it, and whether the later candle path validated it.
- Reasoning is a required output, not a decoration. Every simulated trade should answer: why this side, why now, what sensors agreed, what vetoes failed/passed, what exit rule fired, and whether the decision aged well.
- Current grind results are bad because the placeholder OHLC sensor is weak. That is acceptable for now; the harness being honest is the win.

## Backlog Candidates

- Add a per-candle probability trace output: `time`, `sideOdds`, `score`, `trust`, `sensorContribs`, `vetoes`, `futureOutcome`.
- Add a report section that compares predicted odds vs realized outcomes in probability buckets.
- Add chart overlays for probability clouds/lines, separate from trade markers.
- Port old research metrics as isolated sensor modules, one file per idea, with no hidden cross-dependencies.
- Add an explanation panel that can show decision, entry, exit, and post-trade review for the selected candle.
- Add walk-forward scoring before any config can become `RUN_CANDIDATE`.

## Training Ground Command Spike

The first lego command is intentionally simple:

```powershell
node training_ground\run-experiment.js --agent coin-flip --runs 100 --workers 4 --limit 20000 --name coinflip-stress
```

It uses a seeded coin-flip agent and randomized stress:

- random entry latency in bars
- random slippage in basis points
- random missed orders

Outputs:

- `output/training-ground/<name>.json`
- `output/training-ground/<name>.csv`
- `output/training-ground/<name>.html`

This baseline is useful because a coin-flip agent should not look robust after costs, slippage, latency, and misses. If it does, the training ground is probably leaking, biased, or too forgiving.

Initial baseline results on `2024-10-15T16:20:00Z` through `2024-12-31T20:59:00Z`, 20,000 bars, 100 runs:

- `coinflip-frictionless`: average `+0.48%`, median `+0.60%`, best `+4.81%`, worst `-3.81%`.
- `coinflip-stress`: average `-17.88%`, median `-18.02%`, best `-14.10%`, worst `-21.79%`.

Interpretation: the base simulator is not obviously exploding on a random agent, and the latency/slippage/miss stress is strong enough to punish random trading. For live/paper trading later, measure actual broker/API latency; for backtests, keep using randomized delay/slippage as a stress proxy.

## Chart Sensor Wrapper

Custom chart sensors should stay as plain functions. The chart wrapper calls them with the currently revealed bars:

```js
function mySensor(bars, context) {
  return bars.map((bar, index) => ({
    time: bar.time,
    value: index ? (bar.close - bars[index - 1].close) / bars[index - 1].close : 0
  }));
}

priceChart.add_sensor(mySensor, { name: "my sensor", color: "#58a6ff" });
```

Accepted return shapes:

- numeric array: `[0.1, 0.2, ...]`
- point array: `[{ time, value }, ...]`
- sensor-ish point array: `[{ time, score }]`, `[{ time, signal }]`, or `[{ time, y }]`

## Agent Decision Function

The browser now uses `chart/agent-brain.js` as the editable decision place:

```js
export function decide(frame) {
  const rsi = frame.sensors.rsi?.value;
  if (rsi < 30) return { action: "LONG", reason: "RSI oversold" };
  return { action: "WAIT", reason: "no setup" };
}
```

The same sensors listed in `agentSensors` are drawn as lower chart panes and are available inside `frame.sensors`.

## 2026-08-10 Local Run Notes

- Ran `node test_agent_sources\grind-agent-core.js --runs 32 --workers 4 --limit 30000`.
- Range: `2024-09-09T14:40:00Z` through `2024-12-31T20:59:00Z`.
- Result: average net return `-12.07%`; best run `#29` was `-0.74%` with `80` trades and profit factor `0.97`.
- Interpretation: the current simple OHLC sensor is not tradable. The next useful step is visual diagnosis, not bigger optimization.
- Added `/api/agent/grind` and a browser overlay path for saved grind trades, so the chart can show simulated entries/exits plus score/trust/sensor reasons.
- Attempted to hand the repo task to Codex CLI/Sol. The local CLI started but network access to the OpenAI API was blocked; escalated network access was rejected because it would send repo context externally without explicit approval.
