# Case study - traceable market replay

## Short version

This project is a local market-replay lab for TSLA one-minute candles. It runs repeatable trading experiments, records what each simulated trader knew and did, and exposes suspicious execution cases in an evidence room instead of hiding them inside aggregate backtest stats.

For project vocabulary, see `docs/glossary.md`.

## Problem

Backtests can look precise while relying on assumptions that the data cannot prove.

The concrete example found here is a same-candle entry/exit:

- a position enters on a one-minute OHLC candle;
- the stop/exit also triggers on that same candle;
- OHLC gives `open`, `high`, `low`, `close`;
- OHLC does not preserve the true order of events inside the minute.

So the result is model-dependent. It should be flagged and inspected, not silently trusted as a clean win/loss.

## What was built

- Local Python server over SQLite market data.
- Browser chart workbench for exploring candles and indicators.
- Training-ground runner for repeatable experiments.
- Coin-flip baseline to test simulator behavior before adding smarter strategies.
- Trace outputs for trades, events, decisions, and anomalies.
- Evidence room that turns raw trace rows into an incident report.

## Demo story

1. A simulated trader sees candle data up to the current point.
2. It decides `LONG`, `SHORT`, or `WAIT`.
3. The simulator queues and fills the order under declared stress rules.
4. A stop/exit may later close the position.
5. If entry and exit happen inside the same OHLC candle, the evidence room opens a case.
6. The case report names the responsible layer: execution model plus missing intrabar order.

The important output is not “the trader made money”. The important output is that the simulator exposed a weak assumption.

## Technical contribution

The useful engineering work is the traceability:

- every run has a manifest with command, git SHA, data range, seed, stress settings, and agent config;
- every event has run, agent id, candle index, known time, action, reason, price, equity, and position context;
- anomalies are first-class outputs;
- the UI links readable explanations back to raw event rows.

## How to run locally

Start the app:

```powershell
.\RUNME.ps1
```

Generate a repeatable demo trace from the app with `make demo trace`, or from the terminal:

```powershell
.\RUN-GRIND.ps1 -Runs 32 -Workers 1 -Limit 5000 -Seed 9801 -Name app-demo -DecisionTrace actions
```

Then open:

- `Watch` to explore chart data and indicators;
- `Arena` to view the experiment story;
- `Evidence` to inspect the incident report and raw event log.

## Next proper fix

The evidence room contains the bug class. The full simulator fix is to define explicit execution phases:

```txt
observe -> decide -> queue -> fill -> manage/exit -> settle
```

Until that rule is declared, same-candle entry/exit cases should stay visible as model-dependent evidence.
