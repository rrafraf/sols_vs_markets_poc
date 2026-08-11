# Glossary

Short project vocabulary for the market replay lab.

## App rooms

| Term | Meaning |
| --- | --- |
| `Watch` | Chart workbench for exploring candles, indicators, sensors, and the current playhead. |
| `Arena` | Presentation/story mode for watching an experiment as a replay. |
| `Evidence` | Inspection room for anomaly cases, incident reports, and raw event logs. |

## Market data

| Term | Meaning |
| --- | --- |
| `candle` | One market bar. In this project it is usually one minute of TSLA data. |
| `OHLC` | Open, high, low, close. These are the four prices stored for one candle. |
| `intrabar order` | The true sequence of price moves inside one candle. OHLC does not provide this. |
| `knownUntil` | Last candle/time the trader or strategy was allowed to know when making a decision. Used to detect future leaks. |
| `playhead` / `head` | The current candle being inspected or replayed on the chart. |

## Trading actions

| Term | Meaning |
| --- | --- |
| `LONG` | Enter a position that benefits if price goes up. |
| `SHORT` | Enter a position that benefits if price goes down. |
| `WAIT` | Do not enter a new trade now. |
| `HOLD` | Keep an existing position. Different from `WAIT`, which means no new entry. |
| `EXIT` | Close an existing position. |
| `intent` | The first desired action before review, risk checks, or vetoes. |
| `action` | The final action after the strategy/review layer. |
| `reason` | Short explanation for why an event or action happened. |

## Simulator / execution

| Term | Meaning |
| --- | --- |
| `simulator` / `sim` | Code that replays candles and applies order, fill, exit, stress, and accounting rules. |
| `execution model` | The declared rules for when decisions become orders, when orders fill, and when exits can happen. |
| `order submitted` | A trader/strategy asked to open a position. |
| `order filled` | The simulator opened the position at a recorded price. |
| `latency` | Delay between decision/submission and fill. Usually measured in bars here. |
| `slippage` | Difference between expected price and simulated fill/exit price. Usually measured in basis points. |
| `missed order` | A submitted order that does not fill. Used as stress/noise in experiments. |
| `stop` | Exit rule that closes a position after adverse price movement. |
| `take` | Exit rule that closes a position after favorable price movement. |
| `max hold` | Exit rule that closes a position after too many bars. |
| `phase` | A proposed stricter lifecycle step, such as observe, decide, queue, fill, manage, settle. |

## Trace / observability

| Term | Meaning |
| --- | --- |
| `trace` | Recorded rows explaining what happened during a run. |
| `event log` | Raw chronological event rows: order submitted, order filled, exit, blocked decision, etc. |
| `decision trace` | Rows recording what the strategy decided, what it knew, and why. |
| `trade trace` | Rows for completed trades: entry, exit, pnl, bars held. |
| `anomaly` | A suspicious or model-dependent event that must be inspected. |
| `evidence case` | A selected anomaly with incident report plus raw supporting rows. |
| `manifest` | Metadata for a run: command, git SHA, data range, seed, stress settings, agent config. |
| `run` | One experiment execution over a candle slice. |
| `seed` | Number used to make random choices repeatable. Same seed should reproduce the same baseline behavior. |
| `worker` | Parallel runner process/thread. For clean replay, one worker is easier to reason about. |

## Same-candle issue

| Term | Meaning |
| --- | --- |
| `same-candle entry/exit` | A position opens and closes inside the same candle. |
| `ENTRY_EXIT_SAME_CANDLE` | Current anomaly type for same-candle entry/exit. |
| `model-dependent result` | A result that depends on an assumption the data cannot prove. |
| `candle malfunction` | UI/story phrase for a candle whose OHLC data is insufficient to prove the event order. Not a corrupt data row. |
| `contained` | The anomaly is visible and logged. It is not silently trusted. |
| `full fix` | Defining stricter execution phases so ambiguous same-candle outcomes are handled by explicit rules. |

## Agent / trader language

| Term | Meaning |
| --- | --- |
| `agent` | Code object that makes decisions. Use carefully in public wording; "trader" or "contestant" may read better. |
| `trader` | Human-friendly word for the thing making decisions in the replay. |
| `contestant` | Story-mode word for a trader in the Arena. |
| `coin-flip baseline` | Intentionally dumb random trader used to test whether the simulator behaves sensibly before adding smarter strategies. |
| `random baseline` | Same idea as coin-flip baseline: a sanity check, not a trading strategy. |

## Strategy concepts

| Term | Meaning |
| --- | --- |
| `signal` | Market/chart input that suggests a direction or condition. |
| `modifier` | Extra factor that changes a raw intent, such as risk, memory, uncertainty, or group result. |
| `state` | Persistent information carried across candles, such as position, equity, cooldown, memory. |
| `risk` | Estimated downside if the action is wrong. |
| `size` | How much equity/notional the action uses. |
| `veto` | A reason to block an otherwise valid entry. |
| `memory` | Stored outcome history that may influence future decisions. |
| `confidence` | Strength of the strategy's belief. Should be normalized and logged if used. |

## Output files

| File pattern | Meaning |
| --- | --- |
| `output/training-ground/<name>.json` | Summary and manifest for an experiment. |
| `output/training-ground/<name>.csv` | Per-run summary table. |
| `output/training-ground/<name>.events.csv` | Event log. |
| `output/training-ground/<name>.decisions.csv` | Decision trace. |
| `output/training-ground/<name>.trades.csv` | Completed trades. |
| `output/training-ground/<name>.anomalies.csv` | Anomaly/evidence list. |
| `latest.*` | Most recent experiment output copied for the app to load easily. |
