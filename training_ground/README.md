# Training Ground

Small modular experiment runner for trying many agent/stress combinations.

Current spike:

```powershell
node training_ground\run-experiment.js --agent coin-flip --runs 100 --workers 4 --limit 20000 --name coinflip-stress
```

Outputs:

- `output/training-ground/<name>.json`
- `output/training-ground/<name>.csv`
- `output/training-ground/<name>.html`

The first agent is intentionally dumb. A coin flip agent is useful because it gives us a baseline: if random entries look good, the simulator or market slice is suspicious; if random entries look bad after costs/latency, the ground is probably being honest.

Latency model:

- `entryDelayBars`: random extra bars between decision and fill.
- `slippageBps`: random fill penalty per side.
- `missProbability`: random missed orders.

This is not a real network simulator. It is a backtest stress proxy for order delay, bad fills, and dropped orders.
