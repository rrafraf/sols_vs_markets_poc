# Training Ground

Small modular experiment runner for trying many agent/stress combinations.

Current spike:

```powershell
node training_ground\run-experiment.js --agent coin-flip --runs 100 --workers 1 --limit 20000 --name coinflip-stress
```

Quick interactive runner:

```powershell
.\RUN-GRIND.ps1
.\RUN-GRIND.ps1 -Stream
.\RUN-GRIND.ps1 -Runs 32 -Workers 4 -Limit 5000 -Name coinflip-play
.\RUN-GRIND.ps1 -Runs 1 -Workers 1 -Limit 300 -DecisionTrace all -Stream
```

Worker rule:

- Use `-Workers 1` for debugging, visual replay, stream logs, and any future shared/group-memory work.
- Use `-Workers 4` only for isolated throughput runs. Current workers do not share mutable state, but timing fields such as `decisionMs` are expected to differ.

Known-issue reproducer:

```powershell
node training_ground\reproduce-same-candle.js
```

This uses synthetic candles to force `ENTRY_EXIT_SAME_CANDLE`. It proves the
current execution model can enter and exit on the same candle when 1Min OHLC data
crosses the stop/take range. It also verifies that no new same-candle order is
submitted after `DECISION_BLOCKED`.

Outputs:

- `output/training-ground/<name>.json`
- `output/training-ground/<name>.csv`
- `output/training-ground/<name>.html`
- `output/training-ground/<name>.trades.csv`
- `output/training-ground/<name>.events.csv`
- `output/training-ground/<name>.decisions.csv`
- `output/training-ground/<name>.anomalies.csv`

The first agent is intentionally dumb. A coin flip agent is useful because it gives us a baseline: if random entries look good, the simulator or market slice is suspicious; if random entries look bad after costs/latency, the ground is probably being honest.

Latency model:

- `entryDelayBars`: random extra bars between decision and fill.
- `slippageBps`: random fill penalty per side.
- `missProbability`: random missed orders.

This is not a real network simulator. It is a backtest stress proxy for order delay, bad fills, and dropped orders.
