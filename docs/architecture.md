# Architecture - market replay machine

High-level map of the system as black boxes.

## One-sentence model

The machine loads historical candles, lets a trader/strategy make decisions using only known data, runs those decisions through a simulator/execution model, records every important event, and lets the UI inspect the resulting evidence.

## Black-box diagram

```mermaid
flowchart LR
  A["Market data source\nAlpaca/Yahoo"] --> B["SQLite market database\n1-minute TSLA candles"]
  B --> C["Local Python API\nserver.py"]
  C --> D["Browser app\nWatch / Arena / Evidence"]

  B --> E["Training ground runner\nrun-experiment.js"]
  E --> F["Trader / strategy\ncoin-flip baseline now"]
  F --> G["Simulator / execution model"]
  G --> H["Trace outputs\nsummary/events/decisions/trades/anomalies"]
  H --> C
  H --> D
```

## Component responsibilities

| Component | Responsibility | Not responsible for |
| --- | --- | --- |
| Market data source | Provides historical candle data. | Deciding trades or simulating fills. |
| SQLite database | Stores normalized market candles locally. | Explaining strategy behavior. |
| Python API | Serves candles and training outputs to the browser. | Trading logic. |
| Browser app | Visualizes chart, story, and evidence. | Backtest truth; it only displays recorded data. |
| Training ground runner | Runs repeatable experiments over candle slices. | UI presentation. |
| Trader / strategy | Produces intent/action such as `LONG`, `SHORT`, `WAIT`. | Filling orders or deciding whether OHLC is ambiguous. |
| Simulator / execution model | Turns decisions into submitted orders, fills, exits, equity updates, and anomalies. | Predicting the market or being a smart trader. |
| Trace outputs | Record what happened and why. | Fixing the issue by themselves. |
| Evidence room | Makes trace cases readable. | Creating new simulation facts. |

## What the simulator is

The simulator is the rule engine between strategy and result.

It answers:

- When does a decision become an order?
- When does the order fill?
- At what price?
- With what latency/slippage/miss behavior?
- When does a stop/take/time exit fire?
- How does equity change?
- Is the result suspicious or model-dependent?

It is not the whole app.

It is not the chart.

It is not the trader brain.

It is the referee/accounting/execution layer.

## Simplified run lifecycle

```mermaid
sequenceDiagram
  participant Data as Candle data
  participant Trader as Trader/strategy
  participant Sim as Simulator
  participant Trace as Trace log
  participant UI as Evidence room

  Data->>Trader: candle context up to knownUntil
  Trader->>Sim: intent/action + reason
  Sim->>Trace: DECISION / ORDER_SUBMITTED
  Sim->>Sim: apply latency, slippage, miss rules
  Sim->>Trace: ORDER_FILLED or ORDER_MISSED
  Sim->>Sim: manage stop/take/max-hold exits
  Sim->>Trace: EXIT / equity update
  Sim->>Trace: ANOMALY if execution is suspicious
  Trace->>UI: evidence case + event log
```

## Same-candle incident path

```mermaid
flowchart TD
  A["Trader asks for entry"] --> B["Simulator queues order"]
  B --> C["Order fills on candle T"]
  C --> D["Stop/exit also triggers on candle T"]
  D --> E{"Does OHLC prove intrabar order?"}
  E -->|"No"| F["Create ENTRY_EXIT_SAME_CANDLE anomaly"]
  F --> G["Evidence room opens case"]
  G --> H["Report: model-dependent result"]
```

## Key boundary

The simulator currently detects the same-candle issue and records it as evidence.

That means the issue is contained and visible.

It does not mean the execution model is fully fixed.

The full fix is to define stricter execution phases:

```txt
observe -> decide -> queue -> fill -> manage/exit -> settle
```

Until those phases are declared, same-candle entry/exit remains a model-dependent result.

## Where to look in code

| Area | File |
| --- | --- |
| Local API and data serving | `server.py` |
| Main app wiring | `app.js` |
| Chart rendering | `chart/price-chart.js` |
| Trace/evidence UI | `chart/trace-panel.js` |
| View modes | `chart/view-mode.js` |
| Experiment runner | `training_ground/run-experiment.js` |
| Runner wrapper | `RUN-GRIND.ps1` |
| App starter | `RUNME.ps1` |

## Related docs

- `docs/glossary.md` - vocabulary.
- `docs/case-study.md` - presentable project story.
- `docs/observability.md` - trace/evidence standard.
- `docs/decision-log.md` - chronological decisions.
