# Decision Log

Chronological record of project decisions and why they were made.
Keep entries short. This is not a full README; it is the archive of "why is this here?".

## 2026-08-11 - Split signal math from strategy wiring

Decision:

- Keep raw indicator math separate from user-facing signal definitions.
- Use `chart/indicators.js` for math and `chart/signals.js` for named signals/sensors.

Why:

- The old agent/tester logic mixed formulas, constants, strategy, and visualization.
- We need to inspect one signal at a time and remove hidden dependencies.

Result:

- Strategy code can refer to named sensors instead of buried calculations.

Related commits:

- `225ddef Split agent signals from indicator math`
- `0ad605b Add configurable agent sensors and strategy entrypoint`

## 2026-08-11 - Rename the strategy input from market to moment

Decision:

- Use `moment` for the object passed into strategy.
- A `moment` means chart location plus current sensor values.

Why:

- `market` sounded like the whole market.
- Strategy does not receive the whole market; it receives one point in time with visible history/sensors.

Result:

- Active path is `momentAt(index, bars, sensors)` -> `decisionAt(moment)`.
- `marketAt` remains only as a compatibility alias.

Related commit:

- `b0b7854 Rename agent market view to moment`

## 2026-08-11 - Keep strategy decisions discrete

Decision:

- Strategy returns a discrete action: `LONG`, `SHORT`, `HOLD`, or `WAIT`.
- Analog values such as belief, risk, memory, size, and drive are decision context, not the action itself.

Why:

- A signal can suggest a direction without forcing an immediate trade.
- We need to see why an agent wanted something and why it did or did not act.

Result:

- `WAIT` means a setup exists but was vetoed or delayed.
- `HOLD` means no actionable setup.

Related commit:

- `deefa8f Add agent intent emotion and risk context`

## 2026-08-11 - Treat the grinder as a lab before a profit machine

Decision:

- First prove the training ground can run experiments and expose bad assumptions.
- Use coin-flip as a dumb baseline.

Why:

- If random entries look strong after costs/stress, the simulator or selected window is suspicious.
- Profit numbers are not useful until the sim is inspectable.

Result:

- Coin-flip baseline runs quickly and loses under stress, which is a useful sanity check.
- Run outputs go to `output/training-ground/`.

Related commits:

- `dfb7606 Add experiment backlog`

## 2026-08-11 - Add observability before adding smarter agents

Decision:

- Add standardized run manifests, trace CSVs, event logs, decision logs, trade logs, and anomaly logs.
- Keep trace output as files, with optional stream mode.

Why:

- Summary PnL is not enough.
- We need to inspect what the agent saw, decided, queued, filled, exited, and what looked suspicious.

Result:

- `RUN-GRIND.ps1` runs the training ground.
- Each run can write:
  - `.html`
  - `.csv`
  - `.json`
  - `.trades.csv`
  - `.events.csv`
  - `.decisions.csv`
  - `.anomalies.csv`

Related commit:

- `eaa1db4 Add grind observability runner`

## 2026-08-11 - Default to one worker for source-of-truth runs

Decision:

- Default grinder workers to `1`.
- Keep multi-worker runs as explicit throughput mode.

Why:

- One worker is easier to debug, replay, and reason about.
- Current workers are isolated and deterministic for trades/events/anomalies, but timing fields like `decisionMs` differ.
- Future shared/group memory must not mutate live across workers.

Result:

- Use `-Workers 1` for debugging, visual replay, stream logs, and future group-memory work.
- Use `-Workers 4` only for isolated throughput runs.

Related commit:

- `fec4101 Default grinder to single worker`

## 2026-08-11 - Separate deterministic booth from chaos/arena stress

Decision:

- Treat deterministic execution as baseline truth.
- Treat random missed/rejected orders, queue pressure, slippage chaos, and agent contention as separate stress modes.

Why:

- Random execution failures are useful for resilience testing but should not be mistaken for clean backtest evidence.
- The sim must say which world it is running: deterministic booth, arena, or chaos.

Result:

- Backlog now records deterministic booth first and chaos/arena stress later.

Related commit:

- `61c020f Document execution stress modes`

## 2026-08-11 - Reproduce same-candle entry/exit before fixing it

Decision:

- Add a deterministic synthetic reproducer for `ENTRY_EXIT_SAME_CANDLE`.

Why:

- A bug/model gap is only useful if we can trigger it on demand.
- The same-candle issue is not an Alpaca API problem in historical replay; it is our execution model being under-specified for 1Min OHLC data.

Result:

- `node training_ground\reproduce-same-candle.js` proves:
  - entry and exit can happen on the same candle;
  - intrabar stop/take ambiguity is detected;
  - no second same-candle order is submitted after `DECISION_BLOCKED`.

Related commit:

- `f52bbf6 Add same-candle execution reproducer`

## Open decision - Define execution physics

Problem:

- Current sim still allows entry and exit on the same candle.
- With 1Min OHLC data, we do not know the intrabar order of high/low after entry.

Candidate decision:

- Add explicit execution phases:
  - observe
  - decide
  - queue
  - fill
  - manage/exit
  - settle

Likely default:

- Decision at candle `T`.
- Fill at a declared timing, probably next candle open.
- Exit checks only after the position is eligible under the execution model.

Why not decided yet:

- We want to choose this as a model rule, not hide it as a one-off ban.
- The reproducer exists first so we can verify any future change.

## Open decision - Build a trace viewer

Problem:

- CSV logs are useful but not enough for human debugging.

Candidate decision:

- Generate or build a trace viewer:
  - choose run;
  - jump to trade/anomaly;
  - show candle context;
  - show event timeline;
  - show agent decision and state.

Why:

- Fast grind creates too much timeline to watch live.
- Replay/time-zoom is the right way to inspect what happened.

## 2026-08-11 - Add trace replay panel to the app

Decision:

- Add a first app-native trace replay panel instead of only describing the problem in docs.
- The panel reads latest training-ground output through `/api/training/*`.

Why:

- Long lists of decisions are hard to understand.
- We need to see "who did what when" for one run and jump the chart to event/anomaly timestamps.

Result:

- The app can show run summary, anomalies, event rows, and a compact same-candle story.
- This is not the final visual debugger; it is the first usable replay surface.

## 2026-08-11 - Add human-readable trace story

Decision:

- Keep raw trace rows as evidence, but add a human-readable story layer above them.
- Add a fixed demo trace action in the app for repeatable local demos.

Why:

- Command-line output and CSV/JSON links are good for development, but not presentable to a non-coder.
- The app should explain the same-candle issue as a sequence of actions, not as files to inspect.

Result:

- The trace panel now shows story cards for what happened, why OHLC makes it ambiguous, what the simulator did, and what the safety rule does.
- The raw event rows remain visible for verification.
