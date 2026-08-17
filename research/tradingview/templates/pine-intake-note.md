# Pine Intake Note: {{title}}

Status: intake
Source raw file: `{{source_file}}`
Created: {{created_at}}

This note is not validation. It is a review scaffold for deciding whether the raw Pine idea deserves a causal JS translation and a traceable experiment.

## What The Script Tries To Detect

- Market behavior:
- Long/short setup:
- Curve feature or regime:
- Why this might matter:

## Repaint / Future-Looking Risk

- Initial risk rating: unknown
- Pine version:
- Constructs to check:
  - `request.security` lookahead settings
  - negative offsets or future-index references
  - pivot functions that confirm only after later bars
  - `barstate` / realtime-only behavior
  - strategy settings that differ from candle-close replay
- Review notes:

## Key Inputs

- Inputs detected:
- Constants that change behavior:
- Sensible default range for experiments:

## Visual Output

- Overlay or lower pane:
- Lines, bands, markers, colors:
- What should be visible in the trace UI:

## JS Translation Plan

- Minimal causal output per candle:
- State needed across candles:
- Dependencies on OHLCV, session, timeframe, or higher-timeframe data:
- Translation risks:

## Experiment Needed

- Hypothesis:
- Dataset and timeframe:
- Entry/exit interpretation:
- Metrics to compare:
- Baseline:
- Reject criteria:

## Trace Hooks

- Per-candle fields to expose:
- Events or markers to show:
- Explanation text needed for selected candle:

## Decision

- Next step:
- Owner:
- Date:
