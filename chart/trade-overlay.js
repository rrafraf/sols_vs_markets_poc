"use strict";

export function createTradeOverlay({ dataApi, priceChart, windowLoader }) {
  let summary = null;
  let trades = [];
  let stressOffsetBars = 0;
  const byDecisionTime = new Map();
  const byEntryTime = new Map();
  const byExitTime = new Map();

  async function load() {
    const payload = await dataApi.fetchAgentGrind();
    if (!payload) return;
    summary = payload.summary;
    trades = Array.isArray(payload.trades) ? payload.trades : [];
    indexTrades();
  }

  function indexTrades() {
    byDecisionTime.clear();
    byEntryTime.clear();
    byExitTime.clear();
    for (const trade of trades) {
      add(byDecisionTime, trade.decisionTime, trade);
      add(byEntryTime, trade.entryTime, trade);
      add(byExitTime, trade.exitTime, trade);
    }
  }

  function render() {
    if (!trades.length) return;
    const bars = windowLoader.bars().slice(0, windowLoader.index() + 1);
    const allBars = windowLoader.bars();
    const indexByTime = barIndexByTime(allBars);
    const visible = new Set(bars.map(bar => bar.time));
    const markers = [];

    for (const trade of trades) {
      const entryTime = shiftedTime(unix(trade.entryTime), indexByTime, allBars, stressOffsetBars);
      const exitTime = shiftedTime(unix(trade.exitTime), indexByTime, allBars, stressOffsetBars);
      if (visible.has(entryTime)) {
        markers.push({
          time: entryTime,
          position: trade.side === "LONG" ? "belowBar" : "aboveBar",
          color: trade.side === "LONG" ? "#3fb950" : "#f85149",
          shape: trade.side === "LONG" ? "arrowUp" : "arrowDown",
          text: `${trade.side} ${money(trade.pnl)}`
        });
      }
      if (visible.has(exitTime)) {
        markers.push({
          time: exitTime,
          position: trade.pnl >= 0 ? "aboveBar" : "belowBar",
          color: trade.pnl >= 0 ? "#58a6ff" : "#d29922",
          shape: "circle",
          text: `${trade.reason} ${money(trade.pnl)}`
        });
      }
    }

    priceChart.setMarkers(markers);
  }

  function nextEventIndex(currentIndex) {
    return eventIndexFrom(currentIndex, 1);
  }

  function previousEventIndex(currentIndex) {
    return eventIndexFrom(currentIndex, -1);
  }

  function eventIndexFrom(currentIndex, direction) {
    const bars = windowLoader.bars();
    const indexByTime = barIndexByTime(bars);
    const eventIndexes = eventTimes()
      .map(time => shiftedIndex(unix(time), indexByTime, bars, stressOffsetBars))
      .filter(index => index != null)
      .sort((a, b) => a - b);
    if (!eventIndexes.length) return null;

    if (direction > 0) {
      return eventIndexes.find(index => index > currentIndex) ?? eventIndexes[0];
    }
    for (let i = eventIndexes.length - 1; i >= 0; i--) {
      if (eventIndexes[i] < currentIndex) return eventIndexes[i];
    }
    return eventIndexes.at(-1);
  }

  function eventTimes() {
    return trades
      .flatMap(trade => [trade.decisionTime, trade.entryTime, trade.exitTime])
      .filter(Boolean);
  }

  function adjustStressOffset(delta) {
    stressOffsetBars += delta;
    render();
    return stressOffsetBars;
  }

  function resetStressOffset() {
    stressOffsetBars = 0;
    render();
    return stressOffsetBars;
  }

  function stressOffset() {
    return stressOffsetBars;
  }

  function explain(bar) {
    if (!bar) return null;
    const iso = new Date(bar.time * 1000).toISOString().replace(".000Z", "Z");
    const decision = byDecisionTime.get(iso)?.[0];
    if (decision) return describe(decision, "decision");
    const entry = byEntryTime.get(iso)?.[0];
    if (entry) return describe(entry, "entry");
    const exit = byExitTime.get(iso)?.[0];
    if (exit) return describe(exit, "exit");
    return null;
  }

  function describe(trade, phase) {
    const d = trade.decision || {};
    const sensors = (d.topSensors || [])
      .map(s => `${s.name}:${s.value}`)
      .join(" ");
    return {
      action: trade.side,
      reason: `${phase} score ${d.score} trust ${d.trust} pnl ${money(trade.pnl)} ${trade.reason}; ${sensors}`.trim()
    };
  }

  function statsText() {
    const best = summary?.best;
    if (!best) return "";
    return `best grind #${best.run}: ${(best.netReturn * 100).toFixed(2)}%, ${best.tradeCount} trades`;
  }

  return {
    load,
    render,
    nextEventIndex,
    previousEventIndex,
    adjustStressOffset,
    resetStressOffset,
    stressOffset,
    explain,
    statsText
  };
}

function add(map, key, trade) {
  if (!key) return;
  const list = map.get(key) || [];
  list.push(trade);
  map.set(key, list);
}

function unix(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

function barIndexByTime(bars) {
  const out = new Map();
  bars.forEach((bar, index) => out.set(bar.time, index));
  return out;
}

function shiftedIndex(time, indexByTime, bars, offsetBars) {
  const index = indexByTime.get(time);
  if (index == null) return null;
  return Math.max(0, Math.min(bars.length - 1, index + offsetBars));
}

function shiftedTime(time, indexByTime, bars, offsetBars) {
  const index = indexByTime.get(time);
  if (index == null) return time;
  return bars[Math.max(0, Math.min(bars.length - 1, index + offsetBars))].time;
}

function money(v) {
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}
