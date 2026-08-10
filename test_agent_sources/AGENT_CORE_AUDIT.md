# Agent Core Audit

## Verdict

The two files in this folder do **not train an agent brain**.

`agent-core.js` is a fixed-weight trading policy plus a paper-trading simulator. `test-agent-core.js` generates synthetic price bars and synthetic sensor values, then runs the fixed policy against them. There is no parameter optimisation, no model fitting, no persistent learning state, and no database/output persistence.

The current scripts are useful as an **execution/simulation smoke test**, but their PnL is not evidence of market skill.

## Actual path

```text
synthetic random-walk candles
        |
        v
synthetic autocorrelated sensor scores
        |
        v
fixed weighted opinion()
        |
        v
WAIT / LONG / SHORT
        |
        v
next-bar-open simulated entry
        |
        v
stop / target / flip / time exit
        |
        v
trades + events + equity curve + summary metrics
```

## What is useful

- Decisions are made on bar `i` and entries are queued for bar `i+1` open. This is a good causal default.
- Costs are explicit (`fee_rate`, `slippage_rate`).
- Hard portfolio/risk limits exist.
- The simulator returns event and equity traces, which are a good base for visualisation and later forensic replay.
- The code is small enough to audit.

## What is misleading or incomplete

### 1. No learning

The sensor weights are constants inside `opinion()` and never update. The harness repeatedly running this code cannot train anything by itself.

### 2. Harness is non-deterministic

Both synthetic candles and dummy-sensor noise use `Math.random()`. Therefore the same command can produce different bars, decisions and PnL. This conflicts with the stated deterministic/reproducible goal.

### 3. "Walk-forward" does not train

`walkForward()` ignores `trainStart` and `trainEnd`. It simply runs the same fixed policy on each test slice. This is segmented out-of-sample-style evaluation, not walk-forward optimisation/training.

### 4. Synthetic test contains a built-in directional bias

The synthetic return is generated with `(Math.random() - 0.48)`, not `- 0.5`, creating a slight positive drift. The dummy sensors are then derived from the same synthetic returns. This is acceptable for a smoke test that needs actions to fire, but it is not a neutral benchmark.

### 5. Dummy sensors are not independent market evidence

The sensor stream is a transformed version of the same price series being traded, plus random noise. Names such as `geometry`, `motion`, `pressure`, etc. do not create independent information sources.

### 6. Entry fee accounting and trade PnL differ

The entry fee is immediately subtracted from equity. A closed trade's recorded `pnl` subtracts the exit fee but not the already-paid entry fee. Therefore the trade-level PnL/profit-factor accounting is not directly identical to the final-equity accounting.

### 7. `trailing_stop_atr` is effectively unused

A `trail` expression references `pending?.atr` after the pending entry has normally been cleared, and that computed value is not used. The actual stop update tightens using the original entry-to-stop distance, not `trailing_stop_atr`.

### 8. ATR fallback is not ATR

When no ATR is supplied, the fallback takes the **maximum high-low range** across recent bars (and a fixed price floor). That can be a useful volatility proxy, but it is not Average True Range.

### 9. Intrabar ordering is assumed

For a long position the code checks stop before target on the same OHLC bar; for a short it likewise checks stop before target. If both were touched inside one bar, the available OHLC data cannot reveal which occurred first. The implementation is conservative, but the assumption must be explicit.

### 10. No experiment identity or persistence

There is no run ID, seed, config hash, persisted result file or DB record. Once stdout is gone, the experiment provenance is gone.

## Metrics currently available

- final equity
- maximum drawdown
- trade count
- win rate
- profit factor
- equity curve
- queued/entry/exit event stream
- per-window net return in the harness

Potentially useful later, but missing today:

- total return / CAGR where meaningful
- average trade / expectancy
- payoff ratio
- exposure / time in market
- turnover
- gross vs net returns
- total fees/slippage
- MAE / MFE per trade
- Sharpe/Sortino with clearly defined sampling assumptions
- parameter/config identity
- seed/run identity

## Refactor goal

Keep the experiment readable as four explicit pieces:

```text
config        what may be changed
policy        how sensors become a decision
simulator     how decisions become fills/PnL
harness       what experiment is run, with which seed/config, and why
```

A fifth optional piece should render the returned event/equity trace without influencing the strategy.

## Rule for future work

A repeated run only becomes "training" when some state/parameter/model is updated from prior outcomes and that update is persisted or carried into the next run. Otherwise it is repeated evaluation/search, not learning.
