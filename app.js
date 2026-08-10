"use strict";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Config you can tune
// ---------------------------------------------------------------------------
const CFG = {
  symbol: "TSLA",
  timeframe: "1Min",
  windowDays: 8,          // how many trading days stay in memory / chart
  barsPerDay: 390,        // approx 1-min bars in a US session
  prefetchBars: 400,      // start loading next chunk this many bars before the edge
  maxBarsInMemory: 5000,  // hard cap – drop oldest if we exceed this
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let meta = null;                 // { earliest, latest, total } from server
let candles = [];                // currently loaded window only
let windowStartTime = null;
let windowEndTime = null;
let currentIndex = 0;
let chart = null;
let candleSeries = null;
let replayTimer = 0;
let loading = false;
let pendingJump = null;

// Empty agent – the only place that will later be allowed to decide.
const agent = {
  decide(index, bars) {
    void index;
    void bars;
    return { action: "WAIT", reason: "no rule yet" };
  }
};

// ---------------------------------------------------------------------------
// Data API helpers
// ---------------------------------------------------------------------------

async function fetchMeta() {
  try {
    const params = new URLSearchParams({
      symbol: CFG.symbol,
      timeframe: CFG.timeframe
    });
    const res = await fetch(`/api/data/status?${params}`);
    if (!res.ok) return null;
    const j = await res.json();
    return {
      earliest: j.from_1min || j.earliest || j.from,
      latest: j.to_1min || j.latest || j.to,
      total: j.candles_1min || j.total_candles || j.total || 0,
      source: j.source || "unknown"
    };
  } catch {
    return null;
  }
}

async function fetchBars({ start, end, limit, allowEmpty = false } = {}) {
  const params = new URLSearchParams({
    symbol: CFG.symbol,
    timeframe: CFG.timeframe
  });
  if (start) params.set("from", start);
  if (end) params.set("to", end);
  if (limit) params.set("limit", String(limit));

  const res = await fetch(`/api/candles?${params}`);
  if (!res.ok) {
    if (allowEmpty && res.status === 404) return [];
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const payload = await res.json();
  const raw = payload.data || payload.bars || payload;
  if (!Array.isArray(raw)) {
    throw new Error("Invalid bars response");
  }
  if (!raw.length && !allowEmpty) {
    throw new Error("No bars returned");
  }
  return raw.map(normalizeBar).sort((a, b) => a.time - b.time);
}

function normalizeBar(b) {
  const t = typeof b.time === "number"
    ? b.time
    : Math.floor(new Date(b.isoTime || b.t || b.timestamp).getTime() / 1000);
  return {
    time: t,
    open: +b.open || +b.o,
    high: +b.high || +b.h,
    low: +b.low || +b.l,
    close: +b.close || +b.c
  };
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function barsForWindow() {
  return CFG.windowDays * CFG.barsPerDay;
}

async function loadLatestWindow() {
  setStatus("Loading latest window…");
  const limit = Math.min(CFG.maxBarsInMemory, barsForWindow());
  const bars = await fetchBars({ limit });
  setWindow(bars);
  setStatus(`Loaded latest ${bars.length} bars`);
}

async function loadWindowEndingAt(targetEndTime) {
  if (loading) {
    pendingJump = { targetTime: targetEndTime };
    return;
  }
  loading = true;
  setStatus("Loading window…");
  try {
    const limit = Math.min(CFG.maxBarsInMemory, barsForWindow() + 500);
    const endISO = new Date(targetEndTime * 1000).toISOString();
    const bars = await fetchBars({ end: endISO, limit });
    setWindow(bars);
    let idx = bars.length - 1;
    const found = bars.findIndex(b => b.time >= targetEndTime);
    if (found >= 0) idx = found;
    setIndex(idx);
    setStatus(`Window ${fmtTime(bars[0].time)} → ${fmtTime(bars.at(-1).time)}`);
  } catch (err) {
    console.error(err);
    setStatus("Load failed: " + err.message);
  } finally {
    loading = false;
    if (pendingJump) {
      const next = pendingJump;
      pendingJump = null;
      loadWindowEndingAt(next.targetTime);
    }
  }
}

async function maybePrefetch() {
  if (loading || currentIndex < candles.length - CFG.prefetchBars) return;
  if (!candles.length) return;

  const lastTime = candles.at(-1).time;
  const latestTime = meta ? Date.parse(meta.latest) / 1000 : NaN;
  if (Number.isFinite(latestTime) && lastTime >= latestTime) return;

  loading = true;
  setStatus("Prefetching…");
  try {
    const more = await fetchBars({
      start: new Date((lastTime + 60) * 1000).toISOString(),
      limit: CFG.barsPerDay * 2,
      allowEmpty: true
    });
    if (more.length) {
      const newest = candles.at(-1).time;
      const fresh = more.filter(b => b.time > newest);
      if (fresh.length) {
        candles = candles.concat(fresh);
        if (candles.length > CFG.maxBarsInMemory) {
          const drop = candles.length - CFG.maxBarsInMemory;
          candles = candles.slice(drop);
          currentIndex = Math.max(0, currentIndex - drop);
        }
        windowStartTime = candles[0].time;
        windowEndTime = candles.at(-1).time;
        updateHistorySlider();
        $("scrubber").max = candles.length - 1;
        drawChart(currentIndex);
        setStatus(`Prefetched +${fresh.length} bars`);
      } else {
        setStatus("No newer bars");
      }
    }
  } catch (err) {
    console.warn("Prefetch failed", err);
    setStatus("Prefetch failed");
  } finally {
    loading = false;
  }
}

function setWindow(bars) {
  if (!bars.length) throw new Error("Cannot mount an empty chart window");
  candles = bars;
  windowStartTime = bars[0].time;
  windowEndTime = bars.at(-1).time;
  $("scrubber").max = bars.length - 1;
  $("scrubber").value = bars.length - 1;
  updateHistorySlider();
  drawChart(bars.length - 1);
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
function initChart() {
  if (!window.LightweightCharts) {
    throw new Error("Lightweight Charts not loaded");
  }
  const host = $("chart");
  chart = LightweightCharts.createChart(host, {
    width: host.clientWidth,
    height: host.clientHeight,
    layout: { background: { type: "solid", color: "#0d1117" }, textColor: "#c9d1d9" },
    grid: { vertLines: { color: "#21262d" }, horzLines: { color: "#21262d" } },
    rightPriceScale: { borderColor: "#30363d" },
    timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#3fb950",
    downColor: "#f85149",
    borderUpColor: "#3fb950",
    borderDownColor: "#f85149",
    wickUpColor: "#3fb950",
    wickDownColor: "#f85149"
  });
  window.addEventListener("resize", () => {
    chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
  });
}

function drawChart(upToIndex) {
  if (!candleSeries || !candles.length) return;
  candleSeries.setData(candles.slice(0, upToIndex + 1));
}

// ---------------------------------------------------------------------------
// Playhead
// ---------------------------------------------------------------------------
function setIndex(i) {
  currentIndex = Math.max(0, Math.min(candles.length - 1, i));
  drawChart(currentIndex);

  const bar = candles[currentIndex];
  $("bar-info").textContent =
    `${fmtTime(bar.time)}  ·  O ${bar.open.toFixed(2)}  H ${bar.high.toFixed(2)}  L ${bar.low.toFixed(2)}  C ${bar.close.toFixed(2)}`;

  // Agent only sees bars up to the playhead (causal)
  const decision = agent.decide(currentIndex, candles.slice(0, currentIndex + 1));
  $("agent-decision").textContent = `${decision.action} — ${decision.reason}`;
  $("agent-decision").dataset.action = decision.action.toLowerCase();

  $("progress").textContent = `${currentIndex + 1} / ${candles.length}`;
  $("scrubber").value = currentIndex;

  maybePrefetch();
}

function play() {
  if (replayTimer) return;
  $("btn-play").textContent = "Pause";
  const tick = () => {
    if (currentIndex >= candles.length - 1) {
      maybePrefetch().then(() => {
        if (currentIndex >= candles.length - 1) stop();
        else {
          setIndex(currentIndex + 1);
          replayTimer = setTimeout(tick, Number($("speed").value) || 120);
        }
      });
      return;
    }
    setIndex(currentIndex + 1);
    replayTimer = setTimeout(tick, Number($("speed").value) || 120);
  };
  replayTimer = setTimeout(tick, Number($("speed").value) || 120);
}

function stop() {
  clearTimeout(replayTimer);
  replayTimer = 0;
  $("btn-play").textContent = "Play";
}

// ---------------------------------------------------------------------------
// History track (full DB span)
// ---------------------------------------------------------------------------
function updateHistorySlider() {
  if (!meta || !windowStartTime) return;
  const earliest = Date.parse(meta.earliest) / 1000 || windowStartTime;
  const latest = Date.parse(meta.latest) / 1000 || windowEndTime;
  const span = Math.max(1, latest - earliest);

  const leftPct = ((windowStartTime - earliest) / span) * 100;
  const rightPct = ((windowEndTime - earliest) / span) * 100;

  $("hist-range").style.left = `${leftPct}%`;
  $("hist-range").style.width = `${Math.max(1, rightPct - leftPct)}%`;
  $("hist-label").textContent =
    `${fmtDate(earliest)}  →  ${fmtDate(latest)}   (${(meta.total || 0).toLocaleString()} bars in DB)`;
}

function onHistoryClick(ev) {
  if (!meta) return;
  const rect = $("hist-track").getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  const earliest = Date.parse(meta.earliest) / 1000;
  const latest = Date.parse(meta.latest) / 1000;
  const targetTime = earliest + pct * (latest - earliest);
  stop();
  loadWindowEndingAt(targetTime);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(msg) { $("status").textContent = msg; }
function fmtTime(unix) {
  return new Date(unix * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
}
function fmtDate(unix) {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric"
  });
}

function bindUI() {
  $("btn-play").addEventListener("click", () => (replayTimer ? stop() : play()));
  $("btn-start").addEventListener("click", () => { stop(); setIndex(0); });
  $("btn-end").addEventListener("click", () => { stop(); setIndex(candles.length - 1); });
  $("scrubber").addEventListener("input", (e) => {
    stop();
    setIndex(Number(e.target.value));
  });
  $("hist-track").addEventListener("click", onHistoryClick);
  $("window-days").addEventListener("change", () => {
    CFG.windowDays = Number($("window-days").value) || 8;
    loadLatestWindow().then(() => setIndex(candles.length - 1));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  try {
    setStatus("Connecting…");
    meta = await fetchMeta();
    initChart();
    bindUI();

    if (meta) {
      $("hist-wrap").hidden = false;
      updateHistorySlider();
    }

    await loadLatestWindow();
    setIndex(candles.length - 1);
  } catch (err) {
    console.error(err);
    setStatus("Error");
    $("fatal").hidden = false;
    $("fatal").textContent =
      err.message +
      "\n\nStart the python server (python server.py) and open this page through it " +
      "so /api/candles returns real Alpaca 1-min data.\n" +
      "Useful: make /api/data/status return earliest/latest/total counts.";
  }
}

main();
