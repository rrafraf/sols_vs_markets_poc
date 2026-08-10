"use strict";

import { fmtDate } from "./format.js";

export function createHistoryTrack({ $, windowLoader, playback }) {
  let meta = null;

  function setMeta(nextMeta) {
    meta = nextMeta;
  }

  function update() {
    const { start, end } = windowLoader.span();
    if (!meta || !start) return;

    const earliest = Date.parse(meta.earliest) / 1000 || start;
    const latest = Date.parse(meta.latest) / 1000 || end;
    const span = Math.max(1, latest - earliest);
    const leftPct = ((start - earliest) / span) * 100;
    const rightPct = ((end - earliest) / span) * 100;

    $("hist-range").style.left = `${leftPct}%`;
    $("hist-range").style.width = `${Math.max(1, rightPct - leftPct)}%`;
    $("hist-label").textContent =
      `${fmtDate(earliest)} -> ${fmtDate(latest)}   (${(meta.total || 0).toLocaleString()} bars in DB)`;
  }

  function onClick(ev) {
    if (!meta) return;

    const rect = $("hist-track").getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const earliest = Date.parse(meta.earliest) / 1000;
    const latest = Date.parse(meta.latest) / 1000;
    const targetTime = earliest + pct * (latest - earliest);
    playback.stop();
    windowLoader.loadWindowEndingAt(targetTime);
  }

  return { setMeta, update, onClick };
}
