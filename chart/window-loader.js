"use strict";

import { fmtTime } from "./format.js";

export function createWindowLoader({ $, cfg, dataApi, priceChart }) {
  let meta = null;
  let candles = [];
  let windowStartTime = null;
  let windowEndTime = null;
  let currentIndex = 0;
  let loading = false;
  let pendingJump = null;
  let onStatus = () => {};
  let onWindowChanged = () => {};
  let onIndexChanged = () => {};

  function setMeta(nextMeta) {
    meta = nextMeta;
  }

  function subscribe({ status, windowChanged, indexChanged } = {}) {
    if (status) onStatus = status;
    if (windowChanged) onWindowChanged = windowChanged;
    if (indexChanged) onIndexChanged = indexChanged;
  }

  function barsForWindow() {
    return cfg.windowDays * cfg.barsPerDay;
  }

  async function loadLatestWindow() {
    onStatus("Loading latest window...");
    const limit = Math.min(cfg.maxBarsInMemory, barsForWindow());
    const bars = await dataApi.fetchBars({ limit });
    setWindow(bars);
    onStatus(`Loaded latest ${bars.length} bars`);
  }

  async function loadWindowEndingAt(targetEndTime) {
    if (loading) {
      pendingJump = { targetTime: targetEndTime };
      return;
    }

    loading = true;
    onStatus("Loading window...");
    try {
      const limit = Math.min(cfg.maxBarsInMemory, barsForWindow() + 500);
      const endISO = new Date(targetEndTime * 1000).toISOString();
      const bars = await dataApi.fetchBars({ end: endISO, limit });
      setWindow(bars);

      let idx = bars.length - 1;
      const found = bars.findIndex(b => b.time >= targetEndTime);
      if (found >= 0) idx = found;
      setIndex(idx);
      onStatus(`Window ${fmtTime(bars[0].time)} -> ${fmtTime(bars.at(-1).time)}`);
    } catch (err) {
      console.error(err);
      onStatus("Load failed: " + err.message);
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
    if (loading || currentIndex < candles.length - cfg.prefetchBars) return;
    if (!candles.length) return;

    const lastTime = candles.at(-1).time;
    const latestTime = meta ? Date.parse(meta.latest) / 1000 : NaN;
    if (Number.isFinite(latestTime) && lastTime >= latestTime) return;

    loading = true;
    onStatus("Prefetching...");
    try {
      const more = await dataApi.fetchBars({
        start: new Date((lastTime + 60) * 1000).toISOString(),
        limit: cfg.barsPerDay * 2,
        allowEmpty: true
      });

      if (!more.length) return;

      const newest = candles.at(-1).time;
      const fresh = more.filter(b => b.time > newest);
      if (!fresh.length) {
        onStatus("No newer bars");
        return;
      }

      candles = candles.concat(fresh);
      if (candles.length > cfg.maxBarsInMemory) {
        const drop = candles.length - cfg.maxBarsInMemory;
        candles = candles.slice(drop);
        currentIndex = Math.max(0, currentIndex - drop);
      }

      windowStartTime = candles[0].time;
      windowEndTime = candles.at(-1).time;
      $("scrubber").max = candles.length - 1;
      priceChart.draw(candles, currentIndex);
      onWindowChanged();
      onIndexChanged();
      onStatus(`Prefetched +${fresh.length} bars`);
    } catch (err) {
      console.warn("Prefetch failed", err);
      onStatus("Prefetch failed");
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
    onWindowChanged();
    setIndex(bars.length - 1);
  }

  function setIndex(i) {
    currentIndex = Math.max(0, Math.min(candles.length - 1, i));
    priceChart.draw(candles, currentIndex);
    onIndexChanged();
    maybePrefetch();
    return currentIndex;
  }

  function setWindowDays(days) {
    cfg.windowDays = days;
  }

  function bars() {
    return candles;
  }

  function activeBar() {
    return candles[currentIndex] || null;
  }

  function index() {
    return currentIndex;
  }

  function lastIndex() {
    return Math.max(0, candles.length - 1);
  }

  function span() {
    return { start: windowStartTime, end: windowEndTime };
  }

  return {
    setMeta,
    subscribe,
    loadLatestWindow,
    loadWindowEndingAt,
    maybePrefetch,
    setIndex,
    setWindowDays,
    bars,
    activeBar,
    index,
    lastIndex,
    span
  };
}
