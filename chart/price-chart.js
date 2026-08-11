"use strict";

export function createPriceChart({ $, chartsLib }) {
  let chart = null;
  let candleSeries = null;
  let host = null;
  let priceHost = null;
  let headLine = null;
  let headBar = null;
  const indicators = [];
  const markerLayers = new Map();
  let lastBars = [];
  let lastUpToIndex = -1;
  let syncingRange = false;

  function init() {
    if (!chartsLib) {
      throw new Error("Lightweight Charts not loaded");
    }

    host = $("chart");
    host.textContent = "";
    priceHost = document.createElement("div");
    priceHost.className = "chart-price-pane";
    host.appendChild(priceHost);
    headLine = document.createElement("div");
    headLine.className = "chart-head-line";
    headLine.hidden = true;
    priceHost.appendChild(headLine);

    const theme = chartTheme();
    chart = chartsLib.createChart(priceHost, {
      width: priceHost.clientWidth,
      height: priceHost.clientHeight,
      layout: { background: { type: "solid", color: theme.bg }, textColor: theme.text },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: chartsLib.CrosshairMode.Normal }
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: theme.green,
      downColor: theme.red,
      borderUpColor: theme.green,
      borderDownColor: theme.red,
      wickUpColor: theme.green,
      wickDownColor: theme.red
    });

    window.addEventListener("resize", () => {
      resize();
    });
    window.addEventListener("themechange", applyTheme);
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateHeadLine);
  }

  function draw(bars, upToIndex) {
    if (!candleSeries || !bars.length) return;
    lastBars = bars;
    lastUpToIndex = upToIndex;
    const visibleBars = bars.slice(0, upToIndex + 1);
    candleSeries.setData(visibleBars);
    drawIndicators(bars, visibleBars, upToIndex);
  }

  function setMarkers(markers) {
    setMarkerLayer("trades", markers);
  }

  function setMarkerLayer(name, markers) {
    markerLayers.set(name, markers || []);
    drawMarkers();
  }

  function setHead(bar) {
    headBar = bar;
    if (!bar) {
      setMarkerLayer("head", []);
      updateHeadLine();
      return;
    }
    setMarkerLayer("head", [{
      time: bar.time,
      position: "aboveBar",
      color: chartTheme().head,
      shape: "circle",
      text: "HEAD"
    }]);
    if (chart.setCrosshairPosition) {
      chart.setCrosshairPosition(bar.close, bar.time, candleSeries);
    }
    updateHeadLine();
  }

  function drawMarkers() {
    if (!candleSeries) return;
    const markers = [...markerLayers.values()].flat()
      .sort((a, b) => Number(a.time) - Number(b.time));
    candleSeries.setMarkers(markers);
  }

  function addIndicator(indicatorFn, options = {}) {
    if (typeof indicatorFn !== "function") {
      throw new TypeError("addIndicator expects an indicator function");
    }

    const meta = indicatorFn.indicator || {};
    const separatePane = (options.pane || meta.pane) === "separate";
    const target = separatePane ? createIndicatorPane(options, meta, indicatorFn) : { chart };
    const seriesOptions = {
      title: options.name || meta.name || indicatorFn.name || "indicator",
      color: options.color || meta.color || "#d29922",
      lineWidth: options.lineWidth || meta.lineWidth || 1,
      priceScaleId: separatePane ? "right" : options.priceScaleId || meta.priceScaleId || "left",
      lastValueVisible: options.lastValueVisible ?? true,
      priceLineVisible: options.priceLineVisible ?? false
    };
    const seriesType = options.seriesType || meta.seriesType || "line";
    const line = seriesType === "histogram"
      ? target.chart.addHistogramSeries(seriesOptions)
      : target.chart.addLineSeries(seriesOptions);

    target.chart.priceScale(separatePane ? "right" : options.priceScaleId || meta.priceScaleId || "left").applyOptions({
      visible: true,
      borderColor: chartTheme().border
    });

    const indicator = { fn: indicatorFn, line, options, pane: target.pane, chart: target.chart };
    indicators.push(indicator);
    if (lastBars.length) {
      const visibleBars = lastBars.slice(0, lastUpToIndex + 1);
      drawIndicator(indicator, lastBars, visibleBars, lastUpToIndex);
    }
    return indicator;
  }

  function removeIndicator(indicator) {
    const index = indicators.indexOf(indicator);
    if (index < 0) return;
    indicator.chart.removeSeries(indicator.line);
    if (indicator.pane) indicator.pane.remove();
    indicators.splice(index, 1);
    resize();
  }

  function drawIndicators(bars, visibleBars, upToIndex) {
    for (const indicator of indicators) {
      drawIndicator(indicator, bars, visibleBars, upToIndex);
    }
  }

  function drawIndicator(indicator, bars, visibleBars, upToIndex) {
    const raw = indicator.fn(visibleBars, {
      allBars: bars,
      visibleBars,
      upToIndex,
      options: indicator.options
    });
    indicator.line.setData(normalizeIndicatorData(raw, visibleBars));
  }

  function createIndicatorPane(options, meta, indicatorFn) {
    const pane = document.createElement("div");
    pane.className = "chart-indicator-pane";
    pane.dataset.indicator = options.name || meta.name || indicatorFn.name || "indicator";
    host.appendChild(pane);

    const theme = chartTheme();
    const paneChart = chartsLib.createChart(pane, {
      width: pane.clientWidth,
      height: pane.clientHeight,
      layout: { background: { type: "solid", color: theme.bg }, textColor: theme.muted },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: {
        borderColor: theme.border,
        scaleMargins: { top: 0.1, bottom: 0.1 }
      },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: chartsLib.CrosshairMode.Normal }
    });

    syncTimeScales(chart, paneChart);
    resize();
    return { chart: paneChart, pane };
  }

  function syncTimeScales(source, target) {
    source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncingRange || !range) return;
      syncingRange = true;
      target.timeScale().setVisibleLogicalRange(range);
      syncingRange = false;
    });
    target.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncingRange || !range) return;
      syncingRange = true;
      source.timeScale().setVisibleLogicalRange(range);
      syncingRange = false;
    });
  }

  function resize() {
    if (!chart || !priceHost) return;
    chart.applyOptions({ width: priceHost.clientWidth, height: priceHost.clientHeight });
    updateHeadLine();
    for (const indicator of indicators) {
      if (!indicator.pane) continue;
      indicator.chart.applyOptions({
        width: indicator.pane.clientWidth,
        height: indicator.pane.clientHeight
      });
    }
  }

  function applyTheme() {
    if (!chart) return;
    const theme = chartTheme();
    applyChartTheme(chart, theme, theme.text);
    if (candleSeries) {
      candleSeries.applyOptions({
        upColor: theme.green,
        downColor: theme.red,
        borderUpColor: theme.green,
        borderDownColor: theme.red,
        wickUpColor: theme.green,
        wickDownColor: theme.red
      });
    }

    const themedCharts = new Set(indicators.map(indicator => indicator.chart));
    for (const indicatorChart of themedCharts) {
      applyChartTheme(indicatorChart, theme, indicatorChart === chart ? theme.text : theme.muted);
    }
  }

  function updateHeadLine() {
    if (!chart || !headLine || !headBar) {
      if (headLine) headLine.hidden = true;
      return;
    }
    const x = chart.timeScale().timeToCoordinate(headBar.time);
    if (x == null) {
      headLine.hidden = true;
      return;
    }
    headLine.hidden = false;
    headLine.style.transform = `translateX(${Math.round(x)}px)`;
  }

  return {
    init,
    draw,
    setMarkers,
    setMarkerLayer,
    setHead,
    addIndicator,
    add_indicator: addIndicator,
    addSensor,
    add_sensor: addSensor,
    removeIndicator
  };

  function addSensor(sensorFn, options = {}) {
    return addIndicator(sensorAdapter(sensorFn), {
      pane: "separate",
      color: chartTheme().blue,
      name: sensorFn.name || "sensor",
      ...options
    });
  }
}

function applyChartTheme(targetChart, theme, textColor) {
  targetChart.applyOptions({
    layout: { background: { type: "solid", color: theme.bg }, textColor },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    rightPriceScale: { borderColor: theme.border },
    timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false }
  });
}

function chartTheme() {
  return {
    bg: cssVar("--chart-bg", "#0d1117"),
    text: cssVar("--chart-text", "#c9d1d9"),
    muted: cssVar("--chart-muted", "#8b949e"),
    grid: cssVar("--chart-grid", "#21262d"),
    border: cssVar("--chart-border", "#30363d"),
    green: cssVar("--green", "#3fb950"),
    red: cssVar("--red", "#f85149"),
    blue: cssVar("--blue", "#58a6ff"),
    head: cssVar("--head-line", "#f0b429")
  };
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function normalizeIndicatorData(raw, bars) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((point, index) => {
      if (point == null) return null;
      if (typeof point === "number") {
        if (!Number.isFinite(point) || !bars[index]) return null;
        return { time: bars[index].time, value: point };
      }
      if (!Number.isFinite(point.value)) return null;
      return {
        ...point,
        time: point.time ?? bars[index]?.time,
        value: point.value
      };
    })
    .filter(point => point && point.time != null);
}

function sensorAdapter(sensorFn) {
  const wrapped = (bars, context) => {
    const raw = sensorFn(bars, context);
    if (!Array.isArray(raw)) return [];
    return raw.map((point, index) => {
      if (typeof point === "number") return point;
      if (point && Number.isFinite(point.value)) return point;
      const value = point?.score ?? point?.signal ?? point?.y;
      if (!Number.isFinite(value)) return null;
      return { time: point.time ?? bars[index]?.time, value };
    });
  };
  wrapped.indicator = {
    name: sensorFn.name || "sensor",
    pane: "separate",
    color: "#58a6ff",
    lineWidth: 1
  };
  return wrapped;
}
