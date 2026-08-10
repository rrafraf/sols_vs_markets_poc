/**
 * Run agent-core.js many times against real SQLite candles.
 *
 * Examples:
 *   node test_agent_sources/grind-agent-core.js --runs 64 --workers 4 --limit 50000
 *   node test_agent_sources/grind-agent-core.js --runs 200 --workers 4 --from 2022-01-01 --to 2024-12-31
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { simulate, DEFAULT_CONFIG, opinion, clamp } = require("./agent-core.js");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");

function parseArgs(argv) {
  const args = {
    db: path.join(ROOT, "data", "market.db"),
    symbol: "TSLA",
    timeframe: "1Min",
    runs: 32,
    workers: 4,
    limit: 60000,
    from: "",
    to: "",
    seed: 1337,
    out: path.join(OUTPUT_DIR, "agent-grind-summary.json"),
    tradesOut: path.join(OUTPUT_DIR, "agent-grind-best-trades.json")
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

  args.runs = Number(args.runs) || 32;
  args.workers = Math.max(1, Number(args.workers) || 4);
  args.limit = Number(args.limit) || 60000;
  args.seed = Number(args.seed) || 1337;
  return args;
}

function loadCandles(args) {
  const py = String.raw`
import json, sqlite3, sys
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
        "time": int(__import__("datetime").datetime.fromisoformat(iso.replace("Z","+00:00")).timestamp()),
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
    throw new Error((res.stderr || res.stdout || "Python candle load failed").trim());
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

function makeConfig(run, seed) {
  const rand = mulberry32(seed + run * 1009);
  const pick = (lo, hi) => lo + rand() * (hi - lo);
  return {
    ...DEFAULT_CONFIG,
    starting_equity: 10_000,
    threshold: pick(0.10, 0.34),
    minTrust: pick(0.12, 0.38),
    stopAtr: pick(0.75, 1.70),
    takeAtr: pick(0.90, 2.80),
    maxHold: Math.round(pick(8, 72)),
    cooldown_bars: Math.round(pick(3, 30)),
    trailing_stop_atr: pick(1.10, 3.00),
    risk_fraction: pick(0.0025, 0.010),
    allocation: pick(0.15, 0.55),
    max_trades_per_session: Math.round(pick(1, 4)),
    warmup_bars: 180
  };
}

function makeSensorFn(candles, sensorCfg = {}) {
  const close = candles.map(b => b.close);
  const atr = rollingAtr(candles, 14);
  const ret = close.map((c, i) => i ? Math.log(c / close[i - 1]) : 0);
  const fast = ema(close, sensorCfg.fast || 12);
  const slow = ema(close, sensorCfg.slow || 48);
  const vol = rollingStd(ret, sensorCfg.volLen || 30);
  const memory = ema(ret.map(v => Math.tanh(v * 180)), sensorCfg.memory || 24);

  return (index) => {
    const c = candles[index];
    const range = Math.max(c.high - c.low, c.close * 0.0001);
    const trend = (fast[index] - slow[index]) / Math.max(atr[index], c.close * 0.001);
    const mom = sum(ret, Math.max(0, index - 8), index + 1) / Math.max(vol[index], 0.0001);
    const body = (c.close - c.open) / range;
    const pressure = ((c.close - c.low) / range - 0.5) * 2;
    const quietTrend = Math.abs(trend) / (1 + vol[index] * 500);

    return {
      geometry: lens(trend / 2.5),
      motion: lens(mom / 3.0),
      momentum: lens((ret[index] || 0) / Math.max(vol[index], 0.0001) / 2.0),
      pressure: lens((body + pressure) / 2.0),
      regime: lens(quietTrend * Math.sign(trend)),
      volatility: lens(-vol[index] * 120),
      atr: atr[index] || c.close * 0.004,
      memory: {
        score: clamp(memory[index] || 0, -1, 1),
        confidence: clamp(0.35 + Math.abs(memory[index] || 0) * 0.6, 0, 1)
      }
    };
  };
}

function lens(value) {
  const v = clamp(value, -1, 1);
  return { value: v, attention: clamp(0.2 + Math.abs(v) * 0.8, 0, 1) };
}

function ema(values, len) {
  const out = new Array(values.length);
  const alpha = 2 / (len + 1);
  let prev = values[0] || 0;
  for (let i = 0; i < values.length; i++) {
    prev = i ? prev + alpha * (values[i] - prev) : values[i];
    out[i] = prev;
  }
  return out;
}

function rollingAtr(candles, len) {
  const tr = candles.map((b, i) => {
    const prev = i ? candles[i - 1].close : b.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  return ema(tr, len);
}

function rollingStd(values, len) {
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - len + 1);
    const slice = values.slice(start, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - avg) ** 2, 0) / slice.length;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

function sum(values, start, end) {
  let total = 0;
  for (let i = start; i < end; i++) total += values[i] || 0;
  return total;
}

function runOne(candles, run, seed) {
  const config = makeConfig(run, seed);
  const sensorFn = makeSensorFn(candles);
  const result = simulate(candles, sensorFn, config);
  const queued = result.events.filter(e => e.type === "QUEUED");
  const entries = result.events.filter(e => e.type === "ENTRY");
  const exits = result.events.filter(e => e.type === "EXIT");

  return {
    run,
    config,
    finalEquity: result.finalEquity,
    netPnl: result.finalEquity - config.starting_equity,
    netReturn: (result.finalEquity - config.starting_equity) / config.starting_equity,
    maxDrawdown: result.maxDrawdown,
    tradeCount: result.tradeCount,
    winRate: result.winRate,
    profitFactor: result.profitFactor,
    queuedCount: queued.length,
    entryCount: entries.length,
    exitCount: exits.length,
    trades: result.trades.map(t => explainTrade(t, candles, sensorFn, config))
  };
}

function explainTrade(trade, candles, sensorFn, config) {
  const decisionIndex = Math.max(0, trade.entryIndex - 1);
  const sensors = sensorFn(decisionIndex);
  const op = opinion(sensors, config);
  return {
    ...trade,
    entryTime: candles[trade.entryIndex]?.isoTime,
    exitTime: candles[trade.exitIndex]?.isoTime,
    decisionIndex,
    decisionTime: candles[decisionIndex]?.isoTime,
    decision: {
      call: op.call,
      score: round(op.score),
      trust: round(op.trust),
      topSensors: Object.entries(sensors)
        .filter(([, v]) => v && Number.isFinite(v.value))
        .map(([name, v]) => ({ name, value: round(v.value), attention: round(v.attention ?? Math.abs(v.value)) }))
        .sort((a, b) => Math.abs(b.value * b.attention) - Math.abs(a.value * a.attention))
        .slice(0, 4)
    }
  };
}

function round(v) {
  return Number.isFinite(v) ? Number(v.toFixed(4)) : v;
}

function summarize(results, candles, args) {
  const sorted = [...results].sort((a, b) => b.netReturn - a.netReturn);
  const avg = results.reduce((s, r) => s + r.netReturn, 0) / results.length;
  return {
    generatedAt: new Date().toISOString(),
    args,
    bars: candles.length,
    from: candles[0]?.isoTime,
    to: candles.at(-1)?.isoTime,
    runs: results.length,
    averageNetReturn: avg,
    best: sorted[0],
    worst: sorted.at(-1),
    top: sorted.slice(0, 10).map(stripTrades),
    all: results.map(stripTrades)
  };
}

function stripTrades(result) {
  const { trades, ...rest } = result;
  return rest;
}

async function runMain() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const candles = loadCandles(args);
  if (candles.length < DEFAULT_CONFIG.warmup_bars + 50) {
    throw new Error(`Not enough candles loaded: ${candles.length}`);
  }

  const workerCount = Math.min(args.workers, args.runs);
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let run = 0; run < args.runs; run++) {
    chunks[run % workerCount].push(run);
  }

  const batches = await Promise.all(chunks.map(chunk => runWorker(candles, chunk, args.seed)));
  const results = batches.flat().sort((a, b) => a.run - b.run);
  const summary = summarize(results, candles, args);
  fs.writeFileSync(args.out, JSON.stringify(summary, null, 2));
  fs.writeFileSync(args.tradesOut, JSON.stringify(summary.best?.trades || [], null, 2));

  console.log(`Bars: ${candles.length} ${candles[0].isoTime} -> ${candles.at(-1).isoTime}`);
  console.log(`Runs: ${results.length} using ${workerCount} workers`);
  console.log(`Average net return: ${(summary.averageNetReturn * 100).toFixed(2)}%`);
  console.log(`Best run: #${summary.best.run} net ${(summary.best.netReturn * 100).toFixed(2)}%, trades ${summary.best.tradeCount}, PF ${fmtPf(summary.best.profitFactor)}`);
  console.log(`Worst run: #${summary.worst.run} net ${(summary.worst.netReturn * 100).toFixed(2)}%, trades ${summary.worst.tradeCount}, PF ${fmtPf(summary.worst.profitFactor)}`);
  console.log(`Summary: ${path.relative(ROOT, args.out)}`);
  console.log(`Best trades: ${path.relative(ROOT, args.tradesOut)}`);
}

function runWorker(candles, runs, seed) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { candles, runs, seed } });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0) reject(new Error(`Worker exited ${code}`));
    });
  });
}

function fmtPf(v) {
  return v === Infinity ? "Inf" : Number.isFinite(v) ? v.toFixed(2) : String(v);
}

if (isMainThread) {
  runMain().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
} else {
  parentPort.postMessage(workerData.runs.map(run => runOne(workerData.candles, run, workerData.seed)));
}
