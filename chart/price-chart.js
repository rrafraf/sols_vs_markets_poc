"use strict";

export function createPriceChart({ $, chartsLib }) {
  let chart = null;
  let candleSeries = null;

  function init() {
    if (!chartsLib) {
      throw new Error("Lightweight Charts not loaded");
    }

    const host = $("chart");
    chart = chartsLib.createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: { background: { type: "solid", color: "#0d1117" }, textColor: "#c9d1d9" },
      grid: { vertLines: { color: "#21262d" }, horzLines: { color: "#21262d" } },
      rightPriceScale: { borderColor: "#30363d" },
      timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
      crosshair: { mode: chartsLib.CrosshairMode.Normal }
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

  function draw(bars, upToIndex) {
    if (!candleSeries || !bars.length) return;
    candleSeries.setData(bars.slice(0, upToIndex + 1));
  }

  return { init, draw };
}
