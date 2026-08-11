# Observability Standard

The first job of the training ground is not to prove that an agent makes money.
The first job is to expose leaks, bias, unrealistic assumptions, and bad evaluation.

Every subsystem should make its decisions inspectable enough that we can answer:

- What did it know at this candle?
- What did it decide?
- What parameters affected the decision?
- What happened later?
- Did the simulator accidentally allow future information?

## Required experiment record

Every experiment output should include a run manifest:

| Field | Meaning |
| --- | --- |
| `runId` | Stable experiment name/id. |
| `generatedAt` | UTC timestamp. |
| `gitSha` | Code version used for the run. |
| `command` | Exact command line. |
| `data` | Symbol, timeframe, date range, bar count, DB/source. |
| `agent` | Agent name and version/config. |
| `seed` | Random seed. |
| `workers` | Parallel worker count. |
| `stress` | Latency, slippage, missed order settings. |
| `costs` | Fees/spread/slippage model if separate. |
| `exitRules` | Stop, take, max hold, or strategy exits. |

If a result cannot be tied back to these fields, it is not useful evidence.

## Required parameter docs

Each non-obvious parameter needs one line in a table:

| Field | Required |
| --- | --- |
| `name` | Code/config key. |
| `default` | Default value. |
| `unit` | Bars, bps, equity fraction, probability, etc. |
| `range` | Valid/sensible range. |
| `owner` | Which subsystem reads it. |
| `effect` | What changes when it moves up/down. |
| `loggedAs` | Where it appears in outputs. |

No new knob should be merged if we cannot say what it affects.

## Trace levels

Keep output size controlled with explicit trace levels:

- `summary`: one row per run.
- `trades`: one row per completed trade.
- `orders`: order submit/fill/miss events.
- `decisions`: one row per agent decision candle.
- `debug`: full sensor/modifier dump for visual stepping only.

Default should be `summary,trades,orders`.
`decisions` and `debug` are for smaller windows or targeted visual debugging.

## Event trace schema

All event-like rows should share these base fields:

| Field | Meaning |
| --- | --- |
| `run` | Run number. |
| `agentId` | Agent instance/name. |
| `index` | Candle index known at the time. |
| `time` | Candle timestamp known at the time. |
| `type` | Event type. |
| `action` | LONG, SHORT, HOLD, WAIT, EXIT, MISS, etc. |
| `reason` | Short machine-readable reason. |
| `price` | Price used if relevant. |
| `equity` | Equity after the event if relevant. |
| `position` | Current position summary if relevant. |

Recommended event types:

- `RUN_START`
- `DATA_LOADED`
- `DECISION`
- `ORDER_SUBMITTED`
- `ORDER_FILLED`
- `ORDER_MISSED`
- `EXIT`
- `STATE_UPDATED`
- `RUN_SUMMARY`
- `ANOMALY`

## Decision trace schema

A decision row should be readable without opening the code:

| Field | Meaning |
| --- | --- |
| `intent` | Raw proposed side/action before review. |
| `action` | Final action after review. |
| `reason` | Final reason. |
| `triggers` | Main signal values that created the intent. |
| `modifiers` | Memory/risk/group/internal pressure that changed the intent. |
| `risk` | Estimated downside / adverse move. |
| `size` | Equity fraction or notional requested. |
| `veto` | Why an entry was blocked, if blocked. |
| `knownUntil` | Last candle/time the decision was allowed to know. |

The `knownUntil` field is important. It makes future-leak debugging explicit.

## Monitoring views

Minimum useful views:

- Run table: return, drawdown, trades, win rate, profit factor, latency, missed orders.
- Trade table: entry/exit, pnl, bars held, reason, stress.
- Decision table: intent, action, reason, triggers, modifiers, veto.
- Visual stepping: candle head line plus selected decision/sensor/modifier values.
- Anomaly list: impossible fills, future-looking decisions, extreme slippage, NaN values.

## Leak checks

The runner should eventually flag:

- Decision uses data after `knownUntil`.
- Entry fills before the decision candle.
- Exit checks impossible intra-bar order assumptions without documenting priority.
- Results depend on one narrow market window.
- Random baseline looks too profitable after costs/stress.
- A config wins because of too few trades.
- A metric contains `NaN`, `Infinity`, or silently missing values.

## Rule for new systems

Any new subsystem should provide:

- A short description.
- Its inputs.
- Its outputs.
- Its parameters.
- Its trace fields.
- One sanity test or smoke run.

If it cannot be logged, traced, or sanity-checked, it should not become part of the grinder yet.
