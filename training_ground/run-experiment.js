/**
 * Lego-style experiment command.
 *
 * Example:
 *   node training_ground/run-experiment.js --agent coin-flip --runs 100 --workers 1 --limit 20000
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output", "training-ground");

function parseArgs(argv) {
  const args = {
    agent: "coin-flip",
    db: path.join(ROOT, "data", "market.db"),
    symbol: "TSLA",
    timeframe: "1Min",
    runs: 32,
    workers: 1,
    limit: 20000,
    from: "",
    to: "",
    name: "latest",
    seed: 9001,
    tradeRate: 0.012,
    maxHold: 18,
    stopBps: 45,
    takeBps: 70,
    minLatencyBars: 0,
    maxLatencyBars: 3,
    minSlippageBps: 2,
    maxSlippageBps: 18,
    missProbability: 0.02,
    startingEquity: 10000,
    allocation: 0.25,
    trace: "summary,trades,events,anomalies",
    decisionTrace: "actions",
    streamTrace: false
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = value;
      i++;
    }
  }

  for (const key of [
    "runs", "workers", "limit", "seed", "tradeRate", "maxHold", "stopBps",
    "takeBps", "minLatencyBars", "maxLatencyBars", "minSlippageBps",
    "maxSlippageBps", "missProbability", "startingEquity", "allocation"
  ]) {
    args[key] = Number(args[key]);
  }
  args.workers = Math.max(1, args.workers || 1);
  args.runs = Math.max(1, args.runs || 1);
  return args;
}

function loadCandles(args) {
  const py = String.raw`
import json, sqlite3, sys, datetime
db, symbol, timeframe, from_ts, to_ts, limit = sys.argv[1:7]
limit = int(limit)
where = ["symbol=?", "timeframe=?"]
params = [symbol.upper(), timeframe]
if from_ts:
    where.append("trading_date >= ?")
    params.append(from_ts)
if to_ts:
    where.append("trading_date <= ?")
    params.append(to_ts)
sql = """
SELECT trading_date, open, high, low, close
FROM market_candles
WHERE {where}
ORDER BY trading_date DESC
LIMIT ?
""".format(where=" AND ".join(where))
params.append(limit)
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
rows = list(con.execute(sql, params))
rows.reverse()
out = []
for r in rows:
    iso = r["trading_date"]
    out.append({
        "isoTime": iso,
        "time": int(datetime.datetime.fromisoformat(iso.replace("Z","+00:00")).timestamp()),
        "open": float(r["open"]),
        "high": float(r["high"]),
        "low": float(r["low"]),
        "close": float(r["close"])
    })
print(json.dumps(out, separators=(",", ":")))
`;

  const res = spawnSync("python", [
    "-c",
    py,
    args.db,
    args.symbol,
    args.timeframe,
    args.from || "",
    args.to || "",
    String(args.limit)
  ], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256
  });

  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "Could not load candles").trim());
  }
  return JSON.parse(res.stdout);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coinFlipAgent(rand, args) {
  return {
    name: "coin-flip",
    decide(index, bar) {
      if (rand() > args.tradeRate) {
        return {
          intent: "WAIT",
          action: "WAIT",
          reason: "coin skipped",
          tactic: "random baseline skip",
          triggers: { tradeRate: args.tradeRate }
        };
      }
      const intent = rand() < 0.5 ? "LONG" : "SHORT";
      return {
        intent,
        action: intent,
        reason: "seeded coin flip",
        tactic: "random baseline entry",
        triggers: { tradeRate: args.tradeRate },
        modifiers: { none: true },
        confidence: 0.5,
        index,
        time: bar.isoTime
      };
    }
  };
}

function traceEnabled(args, level) {
  const levels = new Set(String(args.trace || "")
    .split(",")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean));
  return levels.has("all") || levels.has(level) || (level === "events" && levels.has("orders"));
}

function isTruthy(value) {
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

function cleanAction(value) {
  const raw = String(value || "WAIT").toUpperCase();
  return ["LONG", "SHORT", "HOLD", "WAIT", "EXIT"].includes(raw) ? raw : "WAIT";
}

function pushEvent(events, args, event) {
  events.push(event);
  if (isTruthy(args.streamTrace) && traceEnabled(args, "events")) {
    console.log(JSON.stringify({ trace: "EVENT", ...event }));
  }
}

function pushAnomaly(anomalies, args, anomaly) {
  anomalies.push(anomaly);
  if (isTruthy(args.streamTrace) && traceEnabled(args, "anomalies")) {
    console.log(JSON.stringify({ trace: "ANOMALY", ...anomaly }));
  }
}

function keepDecisionTrace(decisions, args, decision) {
  if (!traceEnabled(args, "decisions")) return;
  const mode = String(args.decisionTrace || "actions").toLowerCase();
  const keep = mode === "all" || decision.action !== "WAIT";
  if (!keep) return;
  decisions.push(decision);
  if (isTruthy(args.streamTrace)) {
    console.log(JSON.stringify({ trace: "DECISION", ...decision }));
  }
}

function buildDecisionTrace({ run, agentId, index, bar, prevBar, position, pending, equity, decision, decisionMs }) {
  return {
    run,
    agentId,
    index,
    time: bar.isoTime,
    knownUntil: index,
    position: position?.side || "",
    pending: pending?.side || "",
    equity: round(equity),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    closeChangeBps: prevBar ? round((bar.close / prevBar.close - 1) * 10000) : 0,
    intent: decision.intent || decision.action,
    action: cleanAction(decision.action),
    reason: decision.reason || "",
    tactic: decision.tactic || decision.reason || "",
    confidence: decision.confidence ?? "",
    decisionMs: round(decisionMs),
    triggers: decision.triggers || decision.inputs || {},
    modifiers: decision.modifiers || {},
    risk: decision.risk || {},
    size: decision.size || {},
    veto: decision.veto || ""
  };
}

function runSimulation(candles, args, run) {
  const rand = mulberry32(args.seed + run * 10007);
  const agent = coinFlipAgent(rand, args);
  let equity = args.startingEquity;
  let peak = equity;
  let maxDrawdown = 0;
  let position = null;
  let pending = null;
  const trades = [];
  const events = [];
  const decisions = [];
  const anomalies = [];
  const latencySamples = [];
  const agentId = `${agent.name}-${run}`;

  pushEvent(events, args, {
    run,
    agentId,
    type: "RUN_START",
    index: 0,
    time: candles[0]?.isoTime || "",
    knownUntil: 0,
    action: "START",
    reason: "simulation started",
    equity
  });

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    let lifecycleEvent = "";

    if (pending && pending.fillIndex <= i && !position) {
      if (rand() < args.missProbability) {
        lifecycleEvent = "ORDER_MISSED";
        pushEvent(events, args, {
          run,
          agentId,
          type: "ORDER_MISSED",
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          action: "MISS",
          side: pending.side,
          reason: "stress miss",
          equity,
          position: "",
          decisionIndex: pending.decisionIndex,
          fillIndex: pending.fillIndex,
          delayBars: pending.stress.entryDelayBars,
          slippageBps: pending.stress.slippageBps
        });
        pending = null;
      } else {
        const stress = pending.stress;
        latencySamples.push(stress.entryDelayBars);
        const sideSign = pending.side === "LONG" ? 1 : -1;
        const entry = bar.open * (1 + sideSign * stress.slippageBps / 10000);
        const notional = equity * args.allocation;
        equity -= notional * stress.slippageBps / 10000;
        lifecycleEvent = "ORDER_FILLED";
        position = {
          side: pending.side,
          sideSign,
          entry,
          entryIndex: i,
          entryTime: bar.isoTime,
          decisionIndex: pending.decisionIndex,
          decisionTime: pending.decisionTime,
          notional,
          stop: entry * (1 - sideSign * args.stopBps / 10000),
          take: entry * (1 + sideSign * args.takeBps / 10000),
          stress,
          decision: pending.decision
        };
        pushEvent(events, args, {
          run,
          agentId,
          type: "ORDER_FILLED",
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          action: position.side,
          side: position.side,
          reason: "entry filled",
          price: entry,
          equity,
          position: position.side,
          decisionIndex: pending.decisionIndex,
          fillIndex: pending.fillIndex,
          delayBars: stress.entryDelayBars,
          slippageBps: stress.slippageBps,
          details: { entryStress: stress }
        });
        pending = null;
      }
    }

    if (position) {
      const exit = exitSignal(position, bar, i, args);
      if (exit) {
        lifecycleEvent = lifecycleEvent ? `${lifecycleEvent}+EXIT` : "EXIT";
        if (exit.ambiguous) {
          pushAnomaly(anomalies, args, {
            run,
            agentId,
            index: i,
            time: bar.isoTime,
            knownUntil: i,
            type: "INTRABAR_EXIT_AMBIGUITY",
            severity: "warning",
            message: "stop and take were both reachable inside the same candle; simulator chose stop first",
            details: {
              side: position.side,
              stop: position.stop,
              take: position.take,
              high: bar.high,
              low: bar.low
            }
          });
        }
        pushEvent(events, args, {
          run,
          agentId,
          type: "EXIT_DECISION",
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          action: "EXIT",
          side: position.side,
          reason: exit.reason,
          price: exit.price,
          equity,
          position: position.side,
          decisionIndex: position.decisionIndex,
          barsHeld: i - position.entryIndex
        });
        const exitStress = sampleStress(rand, args);
        const exitPrice = exit.price * (1 - position.sideSign * exitStress.slippageBps / 10000);
        const gross = position.notional * ((exitPrice - position.entry) / position.entry) * position.sideSign;
        const costs = position.notional * exitStress.slippageBps / 10000;
        const pnl = gross - costs;
        equity += pnl;
        const trade = {
          run,
          side: position.side,
          decisionIndex: position.decisionIndex,
          decisionTime: position.decisionTime,
          entryIndex: position.entryIndex,
          entryTime: position.entryTime,
          exitIndex: i,
          exitTime: bar.isoTime,
          entry: position.entry,
          exit: exitPrice,
          pnl,
          pnlBps: pnl / position.notional * 10000,
          reason: exit.reason,
          barsHeld: i - position.entryIndex,
          decision: position.decision,
          entryStress: position.stress,
          exitStress
        };
        trades.push(trade);
        if (i === position.entryIndex) {
          pushAnomaly(anomalies, args, {
            run,
            agentId,
            index: i,
            time: bar.isoTime,
            knownUntil: i,
            type: "ENTRY_EXIT_SAME_CANDLE",
            severity: "warning",
            message: "position entered and exited on the same candle; OHLC order is model-dependent",
            details: {
              side: position.side,
              entryIndex: position.entryIndex,
              exitIndex: i,
              exitReason: exit.reason
            }
          });
        }
        if (!Number.isFinite(pnl) || !Number.isFinite(equity)) {
          pushAnomaly(anomalies, args, {
            run,
            agentId,
            index: i,
            time: bar.isoTime,
            knownUntil: i,
            type: "BAD_NUMERIC_RESULT",
            severity: "error",
            message: "exit produced non-finite pnl or equity",
            details: { pnl, equity, trade }
          });
        }
        pushEvent(events, args, {
          run,
          agentId,
          type: "EXIT",
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          action: "EXIT",
          side: position.side,
          reason: exit.reason,
          price: exitPrice,
          pnl,
          equity,
          position: "",
          decisionIndex: position.decisionIndex,
          barsHeld: i - position.entryIndex,
          slippageBps: exitStress.slippageBps,
          details: { exitStress }
        });
        position = null;
      }
    }

    if (lifecycleEvent && !position && !pending && i < candles.length - args.maxLatencyBars - 2) {
      pushEvent(events, args, {
        run,
        agentId,
        type: "DECISION_BLOCKED",
        index: i,
        time: bar.isoTime,
        knownUntil: i,
        action: "WAIT",
        reason: `blocked same-candle decision after ${lifecycleEvent}`,
        equity,
        position: ""
      });
    }

    if (!lifecycleEvent && !position && !pending && i < candles.length - args.maxLatencyBars - 2) {
      const decisionStart = process.hrtime.bigint();
      const decision = agent.decide(i, bar);
      const decisionMs = Number(process.hrtime.bigint() - decisionStart) / 1e6;
      const action = cleanAction(decision.action);
      if (action !== String(decision.action || "").toUpperCase()) {
        pushAnomaly(anomalies, args, {
          run,
          agentId,
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          type: "INVALID_ACTION_NORMALIZED",
          severity: "warning",
          message: "agent returned an unknown action; normalized by runner",
          details: { rawAction: decision.action, normalizedAction: action }
        });
      }
      if (decision.index != null && decision.index !== i) {
        pushAnomaly(anomalies, args, {
          run,
          agentId,
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          type: "DECISION_INDEX_MISMATCH",
          severity: "warning",
          message: "decision reported a different candle index than the runner supplied",
          details: { decisionIndex: decision.index, runnerIndex: i }
        });
      }
      if (decision.time != null && decision.time !== bar.isoTime) {
        pushAnomaly(anomalies, args, {
          run,
          agentId,
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          type: "DECISION_TIME_MISMATCH",
          severity: "warning",
          message: "decision reported a different candle time than the runner supplied",
          details: { decisionTime: decision.time, runnerTime: bar.isoTime }
        });
      }

      const decisionTrace = buildDecisionTrace({
        run,
        agentId,
        index: i,
        bar,
        prevBar: candles[i - 1],
        position,
        pending,
        equity,
        decision: { ...decision, action },
        decisionMs
      });
      keepDecisionTrace(decisions, args, decisionTrace);

      if (action !== "WAIT") {
        const stress = sampleStress(rand, args);
        pending = {
          side: action,
          decision: { ...decision, action },
          decisionIndex: i,
          decisionTime: bar.isoTime,
          fillIndex: i + 1 + stress.entryDelayBars,
          stress
        };
        if (pending.fillIndex <= i) {
          pushAnomaly(anomalies, args, {
            run,
            agentId,
            index: i,
            time: bar.isoTime,
            knownUntil: i,
            type: "FILL_NOT_AFTER_DECISION",
            severity: "error",
            message: "entry fill index is not after decision index",
            details: { fillIndex: pending.fillIndex, decisionIndex: i }
          });
        }
        pushEvent(events, args, {
          run,
          agentId,
          type: "ORDER_SUBMITTED",
          index: i,
          time: bar.isoTime,
          knownUntil: i,
          action,
          side: action,
          reason: decision.reason || "entry requested",
          equity,
          position: "",
          decisionIndex: i,
          fillIndex: pending.fillIndex,
          delayBars: stress.entryDelayBars,
          slippageBps: stress.slippageBps,
          details: {
            intent: decision.intent || action,
            tactic: decision.tactic || decision.reason || "",
            triggers: decision.triggers || decision.inputs || {},
            modifiers: decision.modifiers || {}
          }
        });
      }
    }

    const mtm = position
      ? equity + position.notional * ((bar.close - position.entry) / position.entry) * position.sideSign
      : equity;
    peak = Math.max(peak, mtm);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - mtm) / peak : 0);
  }

  pushEvent(events, args, {
    run,
    agentId,
    type: "RUN_SUMMARY",
    index: candles.length - 1,
    time: candles.at(-1)?.isoTime || "",
    knownUntil: candles.length - 1,
    action: "SUMMARY",
    reason: "simulation finished",
    equity,
    position: position?.side || "",
    details: {
      maxDrawdown,
      tradeCount: trades.length,
      missedOrders: events.filter(e => e.type === "ORDER_MISSED").length
    }
  });

  return summarizeRun(run, args, equity, maxDrawdown, trades, events, decisions, anomalies, latencySamples);
}

function sampleStress(rand, args) {
  const entryDelayBars = Math.floor(args.minLatencyBars + rand() * (args.maxLatencyBars - args.minLatencyBars + 1));
  const slippageBps = args.minSlippageBps + rand() * (args.maxSlippageBps - args.minSlippageBps);
  return { entryDelayBars, slippageBps: round(slippageBps) };
}

function exitSignal(position, bar, index, args) {
  let hitStop;
  let hitTake;
  if (position.side === "LONG") {
    hitStop = bar.low <= position.stop;
    hitTake = bar.high >= position.take;
  } else {
    hitStop = bar.high >= position.stop;
    hitTake = bar.low <= position.take;
  }
  if (hitStop) return { reason: "stop", price: position.stop, ambiguous: Boolean(hitTake) };
  if (hitTake) return { reason: "take", price: position.take };
  if (index - position.entryIndex >= args.maxHold) {
    return { reason: "time", price: bar.close };
  }
  return null;
}

function summarizeRun(run, args, finalEquity, maxDrawdown, trades, events, decisions, anomalies, latencySamples) {
  const wins = trades.filter(t => t.pnl > 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return {
    run,
    agent: args.agent,
    finalEquity,
    netPnl: finalEquity - args.startingEquity,
    netReturn: (finalEquity - args.startingEquity) / args.startingEquity,
    maxDrawdown,
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    averageLatencyBars: latencySamples.length ? latencySamples.reduce((s, v) => s + v, 0) / latencySamples.length : 0,
    missedOrders: events.filter(e => e.type === "ORDER_MISSED").length,
    anomalyCount: anomalies.length,
    trades,
    events,
    decisions,
    anomalies
  };
}

function collectTrace(args, runs) {
  return {
    trades: traceEnabled(args, "trades") ? runs.flatMap(r => r.trades || []) : [],
    events: traceEnabled(args, "events") ? runs.flatMap(r => r.events || []) : [],
    decisions: traceEnabled(args, "decisions") ? runs.flatMap(r => r.decisions || []) : [],
    anomalies: traceEnabled(args, "anomalies") ? runs.flatMap(r => r.anomalies || []) : []
  };
}

function buildManifest(args, candles, generatedAt, command) {
  return {
    runId: cleanName(args.name || "latest"),
    generatedAt,
    gitSha: currentGitSha(),
    gitDirty: currentGitDirty(),
    command,
    data: {
      symbol: args.symbol,
      timeframe: args.timeframe,
      from: candles[0]?.isoTime,
      to: candles.at(-1)?.isoTime,
      bars: candles.length,
      db: path.relative(ROOT, args.db)
    },
    agent: {
      name: args.agent,
      seed: args.seed,
      tradeRate: args.tradeRate
    },
    workers: args.workers,
    trace: {
      levels: args.trace,
      decisionTrace: args.decisionTrace,
      streamTrace: isTruthy(args.streamTrace)
    },
    stress: {
      minLatencyBars: args.minLatencyBars,
      maxLatencyBars: args.maxLatencyBars,
      minSlippageBps: args.minSlippageBps,
      maxSlippageBps: args.maxSlippageBps,
      missProbability: args.missProbability
    },
    exitRules: {
      stopBps: args.stopBps,
      takeBps: args.takeBps,
      maxHold: args.maxHold
    },
    allocation: args.allocation,
    startingEquity: args.startingEquity
  };
}

function currentGitSha() {
  const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  return res.status === 0 ? res.stdout.trim() : "";
}

function currentGitDirty() {
  const res = spawnSync("git", ["status", "--short"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  return res.status === 0 ? Boolean(res.stdout.trim()) : null;
}

function summarizeExperiment(args, candles, runs, command) {
  const sorted = [...runs].sort((a, b) => b.netReturn - a.netReturn);
  const returns = runs.map(r => r.netReturn);
  const generatedAt = new Date().toISOString();
  const trace = collectTrace(args, runs);
  return {
    generatedAt,
    manifest: buildManifest(args, candles, generatedAt, command),
    args,
    bars: candles.length,
    from: candles[0]?.isoTime,
    to: candles.at(-1)?.isoTime,
    runCount: runs.length,
    agent: args.agent,
    averageNetReturn: mean(returns),
    medianNetReturn: percentile(returns, 0.5),
    p05NetReturn: percentile(returns, 0.05),
    p95NetReturn: percentile(returns, 0.95),
    best: stripHeavy(sorted[0]),
    worst: stripHeavy(sorted.at(-1)),
    runs: runs.map(stripHeavy),
    bestTrades: sorted[0]?.trades || [],
    traceCounts: {
      trades: trace.trades.length,
      events: trace.events.length,
      decisions: trace.decisions.length,
      anomalies: trace.anomalies.length
    },
    trace
  };
}

function writeOutputs(summary) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = cleanName(summary.args.name || "latest");
  const outputs = {};
  const { trace, ...jsonSummary } = summary;
  outputs.JSON = path.join(OUTPUT_DIR, `${base}.json`);
  outputs.CSV = path.join(OUTPUT_DIR, `${base}.csv`);
  outputs.HTML = path.join(OUTPUT_DIR, `${base}.html`);
  fs.writeFileSync(outputs.JSON, JSON.stringify(jsonSummary, null, 2));
  fs.writeFileSync(outputs.CSV, renderCsv(summary));
  fs.writeFileSync(outputs.HTML, renderHtml(summary));

  if (traceEnabled(summary.args, "trades")) {
    outputs.TRADES = path.join(OUTPUT_DIR, `${base}.trades.csv`);
    fs.writeFileSync(outputs.TRADES, renderTradeCsv(trace.trades));
  }
  if (traceEnabled(summary.args, "events")) {
    outputs.EVENTS = path.join(OUTPUT_DIR, `${base}.events.csv`);
    fs.writeFileSync(outputs.EVENTS, renderEventCsv(trace.events));
  }
  if (traceEnabled(summary.args, "decisions")) {
    outputs.DECISIONS = path.join(OUTPUT_DIR, `${base}.decisions.csv`);
    fs.writeFileSync(outputs.DECISIONS, renderDecisionCsv(trace.decisions));
  }
  if (traceEnabled(summary.args, "anomalies")) {
    outputs.ANOMALIES = path.join(OUTPUT_DIR, `${base}.anomalies.csv`);
    fs.writeFileSync(outputs.ANOMALIES, renderAnomalyCsv(trace.anomalies));
  }

  if (base !== "latest") {
    fs.writeFileSync(path.join(OUTPUT_DIR, "latest.json"), JSON.stringify(jsonSummary, null, 2));
    fs.writeFileSync(path.join(OUTPUT_DIR, "latest.csv"), renderCsv(summary));
    fs.writeFileSync(path.join(OUTPUT_DIR, "latest.html"), renderHtml(summary));
    if (outputs.TRADES) fs.writeFileSync(path.join(OUTPUT_DIR, "latest.trades.csv"), renderTradeCsv(trace.trades));
    if (outputs.EVENTS) fs.writeFileSync(path.join(OUTPUT_DIR, "latest.events.csv"), renderEventCsv(trace.events));
    if (outputs.DECISIONS) fs.writeFileSync(path.join(OUTPUT_DIR, "latest.decisions.csv"), renderDecisionCsv(trace.decisions));
    if (outputs.ANOMALIES) fs.writeFileSync(path.join(OUTPUT_DIR, "latest.anomalies.csv"), renderAnomalyCsv(trace.anomalies));
  }
  return outputs;
}

function renderCsv(summary) {
  const rows = [
    ["run", "netReturn", "tradeCount", "winRate", "profitFactor", "maxDrawdown", "averageLatencyBars", "missedOrders", "anomalyCount"],
    ...summary.runs.map(r => [
      r.run, r.netReturn, r.tradeCount, r.winRate, r.profitFactor, r.maxDrawdown, r.averageLatencyBars, r.missedOrders, r.anomalyCount
    ])
  ];
  return rows.map(row => row.map(csvCell).join(",")).join("\n");
}

function renderTradeCsv(trades) {
  return renderRows([
    "run", "side", "decisionIndex", "decisionTime", "entryIndex", "entryTime",
    "exitIndex", "exitTime", "entry", "exit", "pnl", "pnlBps", "reason",
    "barsHeld", "decision.intent", "decision.action", "decision.reason",
    "decision.tactic", "entryStress.entryDelayBars", "entryStress.slippageBps",
    "exitStress.slippageBps"
  ], trades);
}

function renderEventCsv(events) {
  return renderRows([
    "run", "agentId", "type", "index", "time", "knownUntil", "action", "side",
    "reason", "price", "pnl", "equity", "position", "decisionIndex", "fillIndex",
    "delayBars", "slippageBps", "barsHeld", "details"
  ], events);
}

function renderDecisionCsv(decisions) {
  return renderRows([
    "run", "agentId", "index", "time", "knownUntil", "position", "pending",
    "equity", "open", "high", "low", "close", "closeChangeBps", "intent",
    "action", "reason", "tactic", "confidence", "decisionMs", "triggers",
    "modifiers", "risk", "size", "veto"
  ], decisions);
}

function renderAnomalyCsv(anomalies) {
  return renderRows([
    "run", "agentId", "index", "time", "knownUntil", "type", "severity",
    "message", "details"
  ], anomalies);
}

function renderRows(columns, rows) {
  return [
    columns,
    ...rows.map(row => columns.map(column => valueAt(row, column)))
  ].map(row => row.map(csvCell).join(",")).join("\n");
}

function valueAt(row, pathName) {
  const parts = pathName.split(".");
  let value = row;
  for (const part of parts) {
    value = value?.[part];
  }
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function renderHtml(summary) {
  const rows = summary.runs
    .slice()
    .sort((a, b) => b.netReturn - a.netReturn)
    .map(r => `<tr><td>${r.run}</td><td>${pct(r.netReturn)}</td><td>${r.tradeCount}</td><td>${pct(r.winRate)}</td><td>${pf(r.profitFactor)}</td><td>${pct(r.maxDrawdown)}</td><td>${round(r.averageLatencyBars)}</td><td>${r.missedOrders}</td><td>${r.anomalyCount}</td></tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Training Ground Results</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#0d1117;color:#c9d1d9}
table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{border:1px solid #30363d;padding:6px 8px;text-align:right}
th{background:#161b22}
td:first-child,th:first-child{text-align:left}
.bad{color:#f85149}.ok{color:#3fb950}
</style>
</head>
<body>
<h1>Training Ground Results</h1>
<p>${summary.agent}, ${summary.runCount} runs, ${summary.bars} bars, ${summary.from} -> ${summary.to}</p>
<p>Average ${pct(summary.averageNetReturn)}, median ${pct(summary.medianNetReturn)}, p05 ${pct(summary.p05NetReturn)}, p95 ${pct(summary.p95NetReturn)}</p>
<p>Best run #${summary.best.run}: ${pct(summary.best.netReturn)}. Worst run #${summary.worst.run}: ${pct(summary.worst.netReturn)}.</p>
<p>Trace rows: ${summary.traceCounts.trades} trades, ${summary.traceCounts.events} events, ${summary.traceCounts.decisions} decisions, ${summary.traceCounts.anomalies} anomalies.</p>
<table>
<thead><tr><th>Run</th><th>Net</th><th>Trades</th><th>Win</th><th>PF</th><th>DD</th><th>Latency</th><th>Misses</th><th>Anom</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body>
</html>`;
}

function stripHeavy(run) {
  const { trades, events, decisions, anomalies, ...light } = run;
  return light;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function round(v) {
  return Number.isFinite(v) ? Number(v.toFixed(4)) : v;
}

function pct(v) {
  return Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : "?";
}

function pf(v) {
  return v === Infinity ? "Inf" : Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "?";
}

function cleanName(name) {
  return String(name).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "latest";
}

async function runMain() {
  const args = parseArgs(process.argv.slice(2));
  if (args.agent !== "coin-flip") {
    throw new Error(`Unknown agent: ${args.agent}`);
  }

  const candles = loadCandles(args);
  const workerCount = Math.min(args.workers, args.runs);
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let run = 0; run < args.runs; run++) {
    chunks[run % workerCount].push(run);
  }

  const batches = isTruthy(args.streamTrace) && workerCount === 1
    ? [chunks[0].map(run => runSimulation(candles, args, run))]
    : await Promise.all(chunks.map(chunk => runWorker(candles, args, chunk)));
  const runs = batches.flat().sort((a, b) => a.run - b.run);
  const command = process.argv.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
  const summary = summarizeExperiment(args, candles, runs, command);
  const outputs = writeOutputs(summary);

  console.log(`Agent: ${summary.agent}`);
  console.log(`Bars: ${summary.bars} ${summary.from} -> ${summary.to}`);
  console.log(`Runs: ${summary.runCount} using ${workerCount} workers`);
  console.log(`Average net return: ${pct(summary.averageNetReturn)}`);
  console.log(`Median net return: ${pct(summary.medianNetReturn)}`);
  console.log(`Best run: #${summary.best.run} ${pct(summary.best.netReturn)}, trades ${summary.best.tradeCount}, PF ${pf(summary.best.profitFactor)}`);
  console.log(`Worst run: #${summary.worst.run} ${pct(summary.worst.netReturn)}, trades ${summary.worst.tradeCount}, PF ${pf(summary.worst.profitFactor)}`);
  console.log(`Trace rows: ${summary.traceCounts.trades} trades, ${summary.traceCounts.events} events, ${summary.traceCounts.decisions} decisions, ${summary.traceCounts.anomalies} anomalies`);
  for (const [label, file] of Object.entries(outputs)) {
    console.log(`${label}: ${path.relative(ROOT, file)}`);
  }
}

function runWorker(candles, args, runs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { candles, args, runs } });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0) reject(new Error(`Worker exited ${code}`));
    });
  });
}

if (isMainThread) {
  runMain().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
} else {
  parentPort.postMessage(workerData.runs.map(run => runSimulation(workerData.candles, workerData.args, run)));
}
