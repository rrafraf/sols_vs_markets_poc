# Backlog

For the short chronological "why did we decide this?" archive, see `docs/decision-log.md`.

## Priority 0 - keep the system small

- Do not add more hidden agent psychology inside `chart/strategy.js`.
- New concepts must first be named as testable variables: signal, modifier, state, memory, risk, size.
- Every new variable needs a visible output or a clear experiment metric. If we cannot inspect it or measure it, it waits.

## Priority 1 - run the grind

Goal: prove the training ground can produce practical output in normal time.

Minimum useful experiment:

- Run the current `coin-flip` baseline.
- Use real candles from `data/market.db`.
- Keep stress enabled: latency, slippage, missed orders.
- Produce JSON, CSV, and HTML results.

Success means:

- The runner finishes without manual intervention.
- Results include return, drawdown, trade count, win rate, profit factor, latency, and missed orders.
- Random entries are not magically great. If random looks strong, the simulator or slice is suspicious.

## Priority 2 - evaluation before smarter agents

Before adding complex strategy logic, decide how results are judged:

- net return
- max drawdown
- survival / account blow-up avoidance
- profit factor
- trade count
- win rate
- average adverse move
- missed winners and avoided losers
- robustness under latency/slippage/missed orders

The practical question is not "did one run win?".
It is: "does this behavior survive many runs and still look useful after stress?"

Also see `docs/observability.md`.
The goal is to find leaks and bad assumptions before trusting any profit result.

## Run log

### 2026-08-11 coin-flip smoke

Command:

```powershell
node training_ground\run-experiment.js --agent coin-flip --runs 32 --workers 4 --limit 5000 --name coinflip-smoke-2026-08-11
```

Result:

- Bars: 5000, `2024-12-10T19:43:00Z` -> `2024-12-31T20:59:00Z`.
- Runs: 32, workers: 4.
- Average net return: -4.75%.
- Median net return: -4.80%.
- Best run: -2.20%.
- Worst run: -7.27%.
- Average trades per run: 51.25.

Interpretation:

- The training ground runs quickly enough for iteration.
- The random baseline loses under stress, which is what we want from a sanity check.
- Next useful run should compare a simple deterministic strategy against this baseline.

## Priority 3 - next architecture split

Current prototype has belief, memory, drive, risk, and size inside `chart/strategy.js`.
Before adding more complexity, split the model into:

- `chart/signals.js` - market/chart signals.
- `chart/modifiers.js` - memory, risk, uncertainty, group pressure, event effects.
- `chart/agent-state.js` - position, equity, recent trades, temperament, cooldown.
- `chart/strategy.js` - intent -> review -> action.

Target decision shape:

```js
decisionAt(moment, agentState, groupState)
```

Where:

- `moment` is the chart location plus current sensor values.
- `agentState` is the individual agent's position, memory, risk budget, and temperament.
- `groupState` is shared grind memory and peer outcome information.

## Priority 4 - group memory / temperament experiments

Only after the baseline grind is trusted:

- Solo stateless formula.
- Solo formula plus memory veto.
- Solo formula plus memory-based sizing.
- Group shared memory.
- Group consensus/disagreement modifier.
- Temperament race: greedy, patient, disciplined, explorer, contrarian.

These are experiments, not permanent architecture until they prove useful.

## Priority 5 - execution modes

Deterministic booth first:

- One worker for source-of-truth replay.
- Explicit candle/phase lifecycle.
- No random missed orders by default.
- Fill timing is part of the execution model, not hidden strategy logic.

Chaos/arena stress later:

- Random latency, missed/rejected orders, slippage, queue pressure.
- Booth capacity and agent contention.
- Useful for distributed pseudo-random systems testing, not for baseline truth.
- Must be visibly labeled as stress output so nobody mistakes it for clean backtest evidence.
