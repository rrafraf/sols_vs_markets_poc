/**
 * Turn output/agent-grind-summary.json into a readable Markdown report.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SUMMARY = path.join(ROOT, "output", "agent-grind-summary.json");
const DEFAULT_REPORT = path.join(ROOT, "output", "agent-grind-report.md");
const DEFAULT_CANDIDATE = path.join(ROOT, "output", "agent-run-candidate.json");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = path.resolve(ROOT, args.summary || DEFAULT_SUMMARY);
  const reportPath = path.resolve(ROOT, args.out || DEFAULT_REPORT);
  const candidatePath = path.resolve(ROOT, args.candidate || DEFAULT_CANDIDATE);

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Missing summary file: ${summaryPath}`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const verdict = grade(summary);
  const report = renderReport(summary, verdict);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  fs.writeFileSync(candidatePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    verdict,
    sourceSummary: path.relative(ROOT, summaryPath),
    config: summary.best?.config || null
  }, null, 2));

  console.log(report);
  console.log(`\nReport: ${path.relative(ROOT, reportPath)}`);
  console.log(`Candidate: ${path.relative(ROOT, candidatePath)}`);
}

function parseArgs(argv) {
  const args = {};
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
  return args;
}

function grade(summary) {
  const best = summary.best || {};
  const avg = Number(summary.averageNetReturn || 0);
  const bestNet = Number(best.netReturn || 0);
  const pf = Number(best.profitFactor || 0);
  const dd = Number(best.maxDrawdown || 0);
  const trades = Number(best.tradeCount || 0);

  const pass =
    avg > 0 &&
    bestNet > 0.01 &&
    pf >= 1.15 &&
    dd <= 0.08 &&
    trades >= 20;

  const weak =
    bestNet > 0 &&
    pf >= 1.05 &&
    dd <= 0.10 &&
    trades >= 10;

  return {
    status: pass ? "RUN_CANDIDATE" : weak ? "WATCH_ONLY" : "NO_GO",
    reason: pass
      ? "Batch passed baseline profitability, drawdown, and trade-count gates."
      : weak
        ? "Best config is positive, but batch average or robustness is not strong enough."
        : "No config cleared the baseline gates. Use output for visual diagnosis, not trading.",
    gates: {
      averageNetReturnPositive: avg > 0,
      bestNetReturnAboveOnePercent: bestNet > 0.01,
      profitFactorAtLeastOnePointOneFive: pf >= 1.15,
      maxDrawdownAtMostEightPercent: dd <= 0.08,
      atLeastTwentyTrades: trades >= 20
    }
  };
}

function renderReport(summary, verdict) {
  const best = summary.best || {};
  const worst = summary.worst || {};
  const top = Array.isArray(summary.top) ? summary.top : [];

  return [
    "# Agent Grind Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Dataset: ${summary.bars || 0} bars, ${summary.from || "?"} -> ${summary.to || "?"}`,
    `Runs: ${summary.runs || 0}`,
    "",
    `Verdict: ${verdict.status}`,
    "",
    verdict.reason,
    "",
    "## Summary",
    "",
    `- Average net return: ${pct(summary.averageNetReturn)}`,
    `- Best run: #${best.run ?? "?"}, net ${pct(best.netReturn)}, trades ${best.tradeCount ?? 0}, win rate ${pct(best.winRate)}, PF ${pf(best.profitFactor)}, max DD ${pct(best.maxDrawdown)}`,
    `- Worst run: #${worst.run ?? "?"}, net ${pct(worst.netReturn)}, trades ${worst.tradeCount ?? 0}, PF ${pf(worst.profitFactor)}, max DD ${pct(worst.maxDrawdown)}`,
    "",
    "## Candidate Config",
    "",
    "```json",
    JSON.stringify(best.config || {}, null, 2),
    "```",
    "",
    "## Gates",
    "",
    ...Object.entries(verdict.gates).map(([name, pass]) => `- ${pass ? "PASS" : "FAIL"} ${name}`),
    "",
    "## Top Runs",
    "",
    "| Run | Net | Trades | Win Rate | PF | Max DD |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...top.slice(0, 10).map(run =>
      `| ${run.run} | ${pct(run.netReturn)} | ${run.tradeCount} | ${pct(run.winRate)} | ${pf(run.profitFactor)} | ${pct(run.maxDrawdown)} |`
    ),
    "",
    "## Next Step",
    "",
    verdict.status === "RUN_CANDIDATE"
      ? "Promote this config only to paper-trade or visual replay. Do not live trade without out-of-sample confirmation."
      : "Inspect the saved trade markers/reasons in the browser. Improve sensors or split walk-forward before running bigger batches."
  ].join("\n");
}

function pct(v) {
  return Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : "?";
}

function pf(v) {
  return v === Infinity ? "Inf" : Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "?";
}

main();
