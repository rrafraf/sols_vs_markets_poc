"use strict";

const fs = require("fs");
const path = require("path");

const REQUIRED_BAR_COLUMNS = new Set(["timestamp", "symbol", "open", "high", "low", "close", "volume"]);
const VALID_VOLUME_POLICIES = new Set(["ignore", "defer", "partial"]);
const VALID_DATA_QUALITY_POLICIES = new Set(["warn", "reject"]);

function runTargetSignalsCli(args, options = {}) {
  const root = options.root || path.resolve(__dirname, "..");
  const barsPath = requiredPath(args.bars, "--bars");
  const signalsPath = requiredPath(args.signals, "--signals");
  const policyPath = requiredPath(args.policy, "--policy");
  const outPath = requiredPath(args.out, "--out");

  const policy = loadJson(policyPath);
  const bars = loadBarsCsv(barsPath);
  const signalPayload = loadJson(signalsPath);
  const signals = loadSignals(signalPayload);
  const result = runTargetSignals({
    bars,
    signals,
    policy,
    runId: policy.run_id || policy.runId || signalPayload.run_id || signalPayload.runId || cleanName(path.basename(outPath, path.extname(outPath))),
    strategy: policy.strategy || signalPayload.strategy || "target_signals",
    dataset: policy.dataset || signalPayload.dataset || path.relative(root, barsPath) || barsPath,
    symbol: policy.symbol || signalPayload.symbol || inferSymbol(bars, signals),
    outPath,
    root
  });

  writeRunResult(result, outPath);
  console.log(`RunResult: ${path.relative(root, outPath)}`);
  return result;
}

function runTargetSignals({ bars, signals, policy, runId, strategy, dataset, symbol, outPath, root }) {
  const initialCash = numberPolicy(policy, ["initial_cash", "initialCash", "starting_cash", "startingCash"], 100000);
  const feeBps = numberPolicy(policy, ["fee_bps", "feeBps"], 0);
  const slippageBps = numberPolicy(policy, ["slippage_bps", "slippageBps"], 0);
  const volumePolicy = normalizeVolumePolicy(policy);
  const dataQualityPolicy = normalizeDataQualityPolicy(policy);
  const allowShort = policy.allow_short !== false && policy.allowShort !== false;
  const notes = [];
  const policyDifferences = [];
  const events = [];
  const decisions = [];
  const anomalies = [];

  if (!bars.length) {
    throw new Error("target-position-v1 requires at least one bar");
  }
  if (!symbol) {
    throw new Error("target-position-v1 could not infer symbol");
  }

  const dataNotes = validateBars(bars);
  notes.push(...dataNotes.map(note => note.message));
  for (const note of dataNotes) {
    const anomaly = {
      type: note.fatal ? "DATA_QUALITY_FATAL" : "DATA_QUALITY_NOTE",
      severity: note.fatal ? "error" : "warning",
      failureClass: note.fatal ? "P0_DATA_INVALID" : "P1_DATA_POLICY",
      timestamp: note.timestamp || "",
      symbol: note.symbol || "",
      message: note.message
    };
    anomalies.push(anomaly);
    events.push({
      type: anomaly.type,
      phase: "guard",
      timestamp: anomaly.timestamp,
      symbol: anomaly.symbol,
      reason: anomaly.message
    });
  }

  const fatalNotes = dataNotes.filter(note => note.fatal);
  if (dataQualityPolicy === "reject" && fatalNotes.length) {
    const detail = fatalNotes.map(note => note.message).join("; ");
    throw new Error(`target-position-v1 rejected dirty bars: ${detail}`);
  }
  if (fatalNotes.length) {
    policyDifferences.push("P0_DATA_INVALID: dirty bars accepted because data_quality=warn");
  }

  const sortedSignals = signals
    .filter(signal => !symbol || signal.symbol === symbol)
    .sort((a, b) => a.timeMs - b.timeMs);

  for (const signal of sortedSignals) {
    if (!allowShort && signal.target_quantity < 0) {
      throw new Error(`target-position-v1 received short target while allow_short=false at ${signal.timestamp}`);
    }
    decisions.push({
      type: "TARGET_SIGNAL",
      phase: "decide",
      timestamp: signal.timestamp,
      symbol: signal.symbol,
      target_quantity: signal.target_quantity,
      reason: signal.reason || ""
    });
  }

  let cash = initialCash;
  let position = 0;
  let signalIndex = 0;
  let pendingSignal = null;
  const fills = [];

  for (const bar of bars) {
    if (bar.symbol !== symbol) continue;

    while (signalIndex < sortedSignals.length && sortedSignals[signalIndex].timeMs < bar.timeMs) {
      pendingSignal = sortedSignals[signalIndex];
      events.push({
        type: "SIGNAL_PENDING",
        phase: "queue",
        timestamp: bar.timestamp,
        symbol,
        source_signal_timestamp: pendingSignal.timestamp,
        target_quantity: pendingSignal.target_quantity,
        reason: pendingSignal.reason || ""
      });
      signalIndex += 1;
    }

    if (pendingSignal == null) continue;

    const delta = pendingSignal.target_quantity - position;
    if (Math.abs(delta) < 1e-12) {
      pendingSignal = null;
      continue;
    }

    if (volumePolicy !== "ignore" && bar.volume <= 0) {
      const message = `deferred fill on zero-volume bar at ${bar.timestamp}`;
      notes.push(message);
      events.push({
        type: "FILL_DEFERRED",
        phase: "fill",
        timestamp: bar.timestamp,
        symbol,
        source_signal_timestamp: pendingSignal.timestamp,
        target_quantity: pendingSignal.target_quantity,
        reason: message
      });
      continue;
    }

    const side = delta > 0 ? "buy" : "sell";
    let quantity = Math.abs(delta);
    if (volumePolicy === "partial" && bar.volume > 0) {
      quantity = Math.min(quantity, bar.volume);
      if (quantity < Math.abs(delta)) {
        notes.push(
          `partial volume-limited fill at ${bar.timestamp}: requested ${formatFloat(Math.abs(delta))}, filled ${formatFloat(quantity)}`
        );
      }
    }

    const price = applySlippage(bar.open, side, slippageBps);
    const notional = quantity * price;
    const fee = notional * feeBps / 10000;

    if (side === "buy") {
      cash -= notional + fee;
      position += quantity;
    } else {
      cash += notional - fee;
      position -= quantity;
    }

    const fill = {
      timestamp: bar.timestamp,
      symbol,
      side,
      quantity,
      price,
      fee,
      source_signal_timestamp: pendingSignal.timestamp
    };
    fills.push(fill);
    events.push({
      type: "ORDER_FILLED",
      phase: "fill",
      timestamp: bar.timestamp,
      symbol,
      side,
      quantity,
      price,
      fee,
      position,
      cash,
      source_signal_timestamp: pendingSignal.timestamp
    });

    if (quantity >= Math.abs(delta) - 1e-12) {
      pendingSignal = null;
    }
  }

  const finalPrice = lastBarForSymbol(bars, symbol).close;
  const finalEquity = cash + position * finalPrice;
  const artifacts = writeArtifacts(outPath, { events, decisions, anomalies });

  return {
    run_id: runId,
    adapter: "muni",
    adapter_policy_version: "target-position-v1",
    strategy,
    dataset,
    symbol,
    initial_cash: initialCash,
    final_cash: cash,
    final_position: position,
    final_price: finalPrice,
    final_equity: finalEquity,
    return_pct: (finalEquity / initialCash - 1) * 100,
    fill_count: fills.length,
    signal_count: sortedSignals.length,
    notes,
    fills,
    policy_differences: policyDifferences,
    artifacts,
    policy: {
      fee_bps: feeBps,
      slippage_bps: slippageBps,
      volume_policy: volumePolicy,
      data_quality: dataQualityPolicy,
      allow_short: allowShort,
      fill_timing: "signal at bar timestamp T fills target delta at next eligible bar open"
    }
  };
}

function requiredPath(value, flagName) {
  if (!value || value === true) {
    throw new Error(`target-position-v1 requires ${flagName}`);
  }
  return path.resolve(String(value));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadSignals(payload) {
  const rows = Array.isArray(payload) ? payload : payload.signals;
  if (!Array.isArray(rows)) {
    throw new Error("signals JSON must be an array or an object with a signals array");
  }
  return rows.map((row, index) => {
    const timestamp = normalizeTimestamp(requiredField(row, "timestamp", index));
    const symbol = String(requiredField(row, "symbol", index));
    const target = row.target_quantity ?? row.targetQuantity ?? row.target_position ?? row.targetPosition;
    if (target == null) {
      throw new Error(`signal ${index} is missing target_quantity`);
    }
    return {
      timestamp,
      timeMs: parseTimestampMs(timestamp),
      symbol,
      target_quantity: Number(target),
      reason: row.reason || ""
    };
  });
}

function requiredField(row, field, index) {
  if (row[field] == null || row[field] === "") {
    throw new Error(`signal ${index} is missing ${field}`);
  }
  return row[field];
}

function loadBarsCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  const missing = [...REQUIRED_BAR_COLUMNS].filter(column => !headers.includes(column));
  if (missing.length) {
    throw new Error(`${filePath} is missing required columns: ${missing.join(", ")}`);
  }

  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    const timestamp = normalizeTimestamp(row.timestamp);
    return {
      timestamp,
      timeMs: parseTimestampMs(timestamp),
      symbol: row.symbol,
      open: parseNumber(row.open, "open", rowIndex),
      high: parseNumber(row.high, "high", rowIndex),
      low: parseNumber(row.low, "low", rowIndex),
      close: parseNumber(row.close, "close", rowIndex),
      volume: parseNumber(row.volume, "volume", rowIndex),
      extra: Object.fromEntries(
        Object.entries(row).filter(([key, value]) => !REQUIRED_BAR_COLUMNS.has(key) && value !== "")
      )
    };
  });
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index];
    if (quoted) {
      if (ch === "\"" && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseNumber(value, field, rowIndex) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`bar row ${rowIndex + 1} has non-numeric ${field}: ${value}`);
  }
  return number;
}

function validateBars(bars) {
  const notes = [];
  const seen = new Set();
  const previousBySymbol = new Map();
  const expectedDeltaBySymbol = new Map();

  for (const bar of bars) {
    const key = `${bar.symbol}\u0000${bar.timestamp}`;
    if (seen.has(key)) {
      notes.push(note(bar, true, `duplicate timestamp for ${bar.symbol} at ${bar.timestamp}`));
    }
    seen.add(key);

    const previous = previousBySymbol.get(bar.symbol);
    if (previous != null && bar.timeMs <= previous.timeMs) {
      notes.push(note(bar, true, `out-of-order timestamp for ${bar.symbol} at ${bar.timestamp}`));
    } else if (previous != null) {
      const delta = bar.timeMs - previous.timeMs;
      const expectedDelta = expectedDeltaBySymbol.get(bar.symbol);
      if (expectedDelta == null) {
        expectedDeltaBySymbol.set(bar.symbol, delta);
      } else if (delta !== expectedDelta) {
        notes.push(note(
          bar,
          false,
          `irregular timestamp gap for ${bar.symbol} before ${bar.timestamp}: expected ${durationMs(expectedDelta)}, got ${durationMs(delta)}`
        ));
      }
    }
    previousBySymbol.set(bar.symbol, bar);

    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) {
      notes.push(note(bar, true, `invalid OHLC range for ${bar.symbol} at ${bar.timestamp}`));
    }
    if (Math.min(bar.open, bar.high, bar.low, bar.close) <= 0) {
      notes.push(note(bar, true, `non-positive OHLC value for ${bar.symbol} at ${bar.timestamp}`));
    }
    if (bar.volume < 0) {
      notes.push(note(bar, true, `negative volume for ${bar.symbol} at ${bar.timestamp}`));
    }
    if (bar.volume === 0) {
      notes.push(note(bar, false, `zero-volume bar for ${bar.symbol} at ${bar.timestamp}`));
    }
  }

  return notes;
}

function note(bar, fatal, message) {
  return { fatal, message, timestamp: bar.timestamp, symbol: bar.symbol };
}

function normalizeTimestamp(value) {
  const raw = String(value).trim();
  if (!raw) throw new Error("timestamp cannot be empty");
  if (raw.endsWith("Z")) return `${raw.slice(0, -1)}+00:00`;
  if (/[+-]\d\d:\d\d$/.test(raw)) return raw;
  return `${raw}+00:00`;
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value).replace(/\+00:00$/, "Z"));
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return ms;
}

function normalizeVolumePolicy(policy) {
  let value = policy.volume_policy || policy.volumePolicy;
  if (!value && policy.enforce_volume === false) value = "ignore";
  if (!value && policy.enforceVolume === false) value = "ignore";
  if (!value) value = "partial";
  value = String(value).toLowerCase();
  if (!VALID_VOLUME_POLICIES.has(value)) {
    throw new Error(`volume_policy must be one of ${[...VALID_VOLUME_POLICIES].join(", ")}`);
  }
  return value;
}

function normalizeDataQualityPolicy(policy) {
  let value = policy.data_quality || policy.dataQuality || policy.bar_validation || policy.barValidation || "warn";
  value = String(value).toLowerCase();
  if (!VALID_DATA_QUALITY_POLICIES.has(value)) {
    throw new Error(`data_quality must be one of ${[...VALID_DATA_QUALITY_POLICIES].join(", ")}`);
  }
  return value;
}

function numberPolicy(policy, names, fallback) {
  for (const name of names) {
    if (policy[name] != null) {
      const value = Number(policy[name]);
      if (!Number.isFinite(value)) throw new Error(`policy ${name} must be numeric`);
      return value;
    }
  }
  return fallback;
}

function inferSymbol(bars, signals) {
  return signals[0]?.symbol || bars[0]?.symbol || "";
}

function lastBarForSymbol(bars, symbol) {
  for (let index = bars.length - 1; index >= 0; index--) {
    if (bars[index].symbol === symbol) return bars[index];
  }
  throw new Error(`no bars found for symbol ${symbol}`);
}

function applySlippage(price, side, slippageBps) {
  const multiplier = slippageBps / 10000;
  return side === "buy" ? price * (1 + multiplier) : price * (1 - multiplier);
}

function writeRunResult(result, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function writeArtifacts(outPath, artifacts) {
  const parsed = path.parse(outPath);
  fs.mkdirSync(parsed.dir, { recursive: true });
  const outputs = {};
  for (const [name, rows] of Object.entries(artifacts)) {
    const filePath = path.join(parsed.dir, `${parsed.name}.${name}.csv`);
    outputs[name] = filePath;
    fs.writeFileSync(filePath, renderCsv(rows), "utf8");
  }
  return outputs;
}

function renderCsv(rows) {
  if (!rows.length) return "\n";
  const columns = [...rows.reduce((set, row) => {
    Object.keys(row).forEach(key => set.add(key));
    return set;
  }, new Set())];
  return [
    columns,
    ...rows.map(row => columns.map(column => row[column] ?? ""))
  ].map(row => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value) {
  const text = typeof value === "object" && value != null ? JSON.stringify(value) : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function formatFloat(value) {
  return Number(value).toFixed(8);
}

function durationMs(ms) {
  if (ms % 3600000 === 0) return `${ms / 3600000}:00:00`;
  if (ms % 60000 === 0) return `0:${String(ms / 60000).padStart(2, "0")}:00`;
  if (ms % 1000 === 0) return `0:00:${String(ms / 1000).padStart(2, "0")}`;
  return `${ms}ms`;
}

function cleanName(name) {
  return String(name).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "run-result";
}

module.exports = {
  loadBarsCsv,
  loadSignals,
  runTargetSignals,
  runTargetSignalsCli,
  validateBars
};
