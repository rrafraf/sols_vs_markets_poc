# Sols vs Markets — Backlog

Last updated: 2026-08-10

## Current reality

| Area | Status | Evidence |
|---|---|---|
| Historical chart/data lab | Exists | `server.py`, `chart/*` |
| Chart-side agent | Placeholder only | `chart/agent.js` always returns `WAIT` |
| Trading simulator | Exists | `test_agent_sources/agent-core.js::simulate()` |
| Synthetic harsh-test harness | Exists | `test_agent_sources/test-agent-core.js` |
| Training / learning | **Does not exist yet** | weights are fixed; no cross-run update |
| Parameter optimisation | **Does not exist yet** | `walkForward()` explicitly runs fixed params |
| Persistent experiment/run identity | Missing | no run ID / seed / config persistence |
| Deterministic replay | Partial | core can be deterministic; harness uses unseeded `Math.random()` |

### Baseline observed by Sol Jr

Exact GitHub versions of `agent-core.js` and `test-agent-core.js` match the received ZIP byte-for-byte.

60 independent executions of the current synthetic harness:

- 59 losing, 1 profitable
- mean full-period P&L: about **-$61** from $10,000
- mean walk-forward window return: about **-0.10%**
- ~8 trades/run

This is **not a training result**. Every execution creates a new random synthetic market and random sensor noise; nothing learned in run N is transferred to run N+1.

## Work queue

| Priority | Work | Owner | State | Acceptance |
|---|---|---|---|---|
| P0 | Dissect `agent-core.js` + harness into a plain execution map | **Sol Jr** | IN PROGRESS | Human-readable map: market → sensors → opinion → order → position → exit → metrics |
| P0 | Make synthetic experiments seeded/deterministic | Sol Jr | NEXT | Same seed + config produces identical candles, decisions, trades and result |
| P0 | Add experiment/run metadata | Sol Jr | NEXT | Every run records `run_id`, seed, config, result and failure state |
| P0 | Prevent future credential accidents | Unassigned | TODO | `secrets.ps1` ignored; tracked file becomes safe example/template only |
| P0 | Define what a “training run” actually changes | Human + Sol Jr | TODO | One explicit update rule/state transition; otherwise call it simulation/search, not training |
| P1 | Split test harness responsibilities | Sol Jr | TODO | Synthetic market, synthetic sensors, runner and reporting are separable/testable pieces |
| P1 | Feed real historical candles into the simulator | Unassigned | TODO | One local historical run, no broker writes/network trading |
| P1 | Define/implement a real causal sensor adapter | Unassigned | TODO | Sensor value at T uses only information available at/before T |
| P1 | Tiny N-run experiment runner | Unassigned | TODO | N clean runs; persistent configs/results; summary distribution |
| P1 | Minimal experiment UI | Unassigned | TODO | See active run, decisions/trades, equity, current config/seed, failures |
| P1 | Execution-model adversarial tests | Unassigned | TODO | Explicit tests for slippage, fees, gaps, stop/target collisions and timing |
| P1 | Fix known causality/execution defects before trusting P&L | Unassigned | TODO | Regression tests demonstrate no future-derived session state / target extension issue |
| P2 | Parameter search | Unassigned | BLOCKED | Only after deterministic experiments + unseen validation exist |
| P2 | Diverse specialist agents | Unassigned | IDEA | Each personality maps to explicit inputs/policy/risk parameters |
| P2 | Frontier LLM supervisory/research layer | Unassigned | IDEA | Kept outside deterministic execution/risk path until measurable value exists |

## Proposed small decomposition

Current two-file test can become:

```text
synthetic-market.js     generate candles from seed
        ↓
synthetic-sensors.js    transform visible history → sensor state
        ↓
agent-core.js           fixed policy + execution simulation
        ↓
experiment-runner.js    run_id / seed / config / N runs
        ↓
experiment-store.*      durable result + trace
        ↓
reporter / UI           inspect what happened
```

**Important:** decomposition should preserve behavior first. No strategy redesign hidden inside cleanup.

## What “training” could mean later

Do not use the word unless something actually changes between runs.

Possible future mechanisms:

1. **Parameter search** — choose thresholds/weights/configs using a train segment; evaluate winners on unseen data.
2. **Online learning** — update weights/state after observations/outcomes.
3. **Population/evolution** — mutate/select multiple policies across generations.
4. **Model training** — fit parameters from data with an explicit loss/objective.

Current code does **none** of these.

## Team / coordination

- **Human (rafa):** research direction, risk/architecture decisions, calls BS.
- **Sol Jr:** current owner of agent-core/harness dissection + experiment machinery proposal.
- **OG Sol:** historical project context; sync useful when available.
- **Codex:** implementation worker when a bounded task + tests are defined.

Use this file as the lightweight shared queue. Add detail elsewhere in `admin/` only when it earns its existence.

## Rules of the lab

- Evidence > story.
- A weird result is an investigation target, not an edge.
- No live trading while experiment semantics are uncertain.
- Persist failures, WAIT decisions and rejected actions—not only winning trades.
- Prefer a small deterministic experiment over a huge opaque search.
