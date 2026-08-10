/**
 * Lego-style experiment command.
 *
 * Example:
 *   node training_ground/run-experiment.js --agent coin-flip --runs 100 --workers 4 --limit 20000
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
    workers: 4,
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
    allocation: 0.25
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
        return { action: "WAIT", reason: "coin skipped" };
      }
      return {
        action: rand() < 0.5 ? "LONG" : "SHORT",
        reason: "seeded coin flip",
        confidence: 0.5,
        index,
        time: bar.isoTime
      };
    }
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
  const latencySamples = [];

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    if (pending && pending.fillIndex <= i && !position) {
      if (rand() < args.missProbability) {
        events.push({ type: "MISS", index: i, side: pending.side, reason: "stress miss" });
        pending = null;
      } else {
        const stress = sampleStress(rand, args);
        latencySamples.push(stress.entryDelayBars);
        const sideSign = pending.side === "LONG" ? 1 : -1;
        const entry = bar.open * (1 + sideSign * stress.slippageBps / 10000);
        const notional = equity * args.allocation;
        equity -= notional * stress.slippageBps / 10000;
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
        events.push({ type: "ENTRY", index: i, side: position.side, price: entry, stress });
        pending = null;
      }
    }

    if (position) {
      const exit = exitSignal(position, bar, i, args);
      if (exit) {
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
        events.push({ type: "EXIT", index: i, side: position.side, price: exitPrice, pnl, reason: exit.reason });
        position = null;
      }
    }

    if (!position && !pending && i < candles.length - args.maxLatencyBars - 2) {
      const decision = agent.decide(i, bar);
      if (decision.action !== "WAIT") {
        const stress = sampleStress(rand, args);
        pending = {
          side: decision.action,
          decision,
          decisionIndex: i,
          decisionTime: bar.isoTime,
          fillIndex: i + 1 + stress.entryDelayBars
        };
        events.push({ type: "ORDER", index: i, side: decision.action, fillIndex: pending.fillIndex, stress });
      }
    }

    const mtm = position
      ? equity + position.notional * ((bar.close - position.entry) / position.entry) * position.sideSign
      : equity;
    peak = Math.max(peak, mtm);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - mtm) / peak : 0);
  }

  return summarizeRun(run, args, equity, maxDrawdown, trades, events, latencySamples);
}

function sampleStress(rand, args) {
  const entryDelayBars = Math.floor(args.minLatencyBars + rand() * (args.maxLatencyBars - args.minLatencyBars + 1));
  const slippageBps = args.minSlippageBps + rand() * (args.maxSlippageBps - args.minSlippageBps);
  return { entryDelayBars, slippageBps: round(slippageBps) };
}

function exitSignal(position, bar, index, args) {
  if (position.side === "LONG") {
    if (bar.low <= position.stop) return { reason: "stop", price: position.stop };
    if (bar.high >= position.take) return { reason: "take", price: position.take };
  } else {
    if (bar.high >= position.stop) return { reason: "stop", price: position.stop };
    if (bar.low <= position.take) return { reason: "take", price: position.take };
  }
  if (index - position.entryIndex >= args.maxHold) {
    return { reason: "time", price: bar.close };
  }
  return null;
}

function summarizeRun(run, args, finalEquity, maxDrawdown, trades, events, latencySamples) {
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
    missedOrders: events.filter(e => e.type === "MISS").length,
    trades,
    events
  };
}

function summarizeExperiment(args, candles, runs) {
  const sorted = [...runs].sort((a, b) => b.netReturn - a.netReturn);
  const returns = runs.map(r => r.netReturn);
  return {
    generatedAt: new Date().toISOString(),
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
    bestTrades: sorted[0]?.trades || []
  };
}

function writeOutputs(summary) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = cleanName(summary.args.name || "latest");
  fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.csv`), renderCsv(summary));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.html`), renderHtml(summary));
  if (base !== "latest") {
    fs.writeFileSync(path.join(OUTPUT_DIR, "latest.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(OUTPUT_DIR, "latest.csv"), renderCsv(summary));
    fs.writeFileSync(path.join(OUTPUT_DIR, "latest.html"), renderHtml(summary));
  }
}

function renderCsv(summary) {
  const rows = [
    ["run", "netReturn", "tradeCount", "winRate", "profitFactor", "maxDrawdown", "averageLatencyBars", "missedOrders"],
    ...summary.runs.map(r => [
      r.run, r.netReturn, r.tradeCount, r.winRate, r.profitFactor, r.maxDrawdown, r.averageLatencyBars, r.missedOrders
    ])
  ];
  return rows.map(row => row.map(csvCell).join(",")).join("\n");
}

function renderHtml(summary) {
  const rows = summary.runs
    .slice()
    .sort((a, b) => b.netReturn - a.netReturn)
    .map(r => `<tr><td>${r.run}</td><td>${pct(r.netReturn)}</td><td>${r.tradeCount}</td><td>${pct(r.winRate)}</td><td>${pf(r.profitFactor)}</td><td>${pct(r.maxDrawdown)}</td><td>${round(r.averageLatencyBars)}</td><td>${r.missedOrders}</td></tr>`)
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
<table>
<thead><tr><th>Run</th><th>Net</th><th>Trades</th><th>Win</th><th>PF</th><th>DD</th><th>Latency</th><th>Misses</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body>
</html>`;
}

function stripHeavy(run) {
  const { trades, events, ...light } = run;
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

  const batches = await Promise.all(chunks.map(chunk => runWorker(candles, args, chunk)));
  const runs = batches.flat().sort((a, b) => a.run - b.run);
  const summary = summarizeExperiment(args, candles, runs);
  writeOutputs(summary);

  console.log(`Agent: ${summary.agent}`);
  console.log(`Bars: ${summary.bars} ${summary.from} -> ${summary.to}`);
  console.log(`Runs: ${summary.runCount} using ${workerCount} workers`);
  console.log(`Average net return: ${pct(summary.averageNetReturn)}`);
  console.log(`Median net return: ${pct(summary.medianNetReturn)}`);
  console.log(`Best run: #${summary.best.run} ${pct(summary.best.netReturn)}, trades ${summary.best.tradeCount}, PF ${pf(summary.best.profitFactor)}`);
  console.log(`Worst run: #${summary.worst.run} ${pct(summary.worst.netReturn)}, trades ${summary.worst.tradeCount}, PF ${pf(summary.worst.profitFactor)}`);
  const base = cleanName(args.name || "latest");
  console.log(`JSON: ${path.relative(ROOT, path.join(OUTPUT_DIR, `${base}.json`))}`);
  console.log(`CSV: ${path.relative(ROOT, path.join(OUTPUT_DIR, `${base}.csv`))}`);
  console.log(`HTML: ${path.relative(ROOT, path.join(OUTPUT_DIR, `${base}.html`))}`);
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
