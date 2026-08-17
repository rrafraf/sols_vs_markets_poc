# TradingView Script Intake

Recovered TradingView/Pine scripts go in `research/tradingview/raw/` unchanged. Treat that folder as an evidence drop zone, not a working folder.

The pipeline is:

```txt
raw script -> intake note -> repaint check -> JS translation plan -> traceable experiment
```

None of these scripts are validated just because they exist. A recovered script becomes useful only after it has a note, a repaint/future-looking risk review, a narrow JS translation plan, and an experiment that can prove it useful or useless.

## Folder Contract

```txt
research/tradingview/raw/           original Pine scripts, never edited in place
research/tradingview/notes/         intake notes for scripts worth reviewing
research/tradingview/templates/     reusable note/process templates
research/tradingview/translations/  JS translations only after note review
```

Rules:

- Do not reformat, rename, normalize, or annotate files inside `raw/`.
- Do not translate Pine directly from `raw/`; create or update an intake note first.
- Keep notes skeptical. The note records what the script appears to do, not that it works.
- Translation output should be small, causal, and traceable by candle before it is connected to strategy decisions.

## Intake Note Checklist

Use `research/tradingview/templates/pine-intake-note.md` for every script that might be worth testing. The note must capture:

- what the script tries to detect;
- repaint or future-looking risk;
- key inputs and constants;
- visual output expected on the chart;
- JS translation plan;
- experiment needed before trusting the idea.

Suggested note status values:

- `intake`: raw script has a note, but no judgment yet.
- `blocked`: cannot evaluate without missing context.
- `reject`: not worth translating, or too future-looking to test honestly.
- `translate`: ready for a small JS port.
- `experiment`: translated enough to run a traceable test.

## Helper Script

The optional helper scans raw files and creates intake-note stubs outside `raw/`. It uses only Node built-ins, does not use the network, and never writes into `research/tradingview/raw/`.

Preview candidates:

```powershell
node scripts\create-tradingview-intake-note.js
```

Create missing note stubs:

```powershell
node scripts\create-tradingview-intake-note.js --create
```

Create a note for one raw file:

```powershell
node scripts\create-tradingview-intake-note.js --script "example.pine" --create
```

If a note already exists, the helper leaves it alone unless `--force` is passed. Generated notes are starting points; a human or agent still needs to fill the risk review and experiment plan.
