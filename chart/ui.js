"use strict";

import { fmtTime } from "./format.js";

export function createUi({ $, cfg, agent, windowLoader, playback, historyTrack }) {
  windowLoader.subscribe({
    status: setStatus,
    windowChanged: historyTrack.update,
    indexChanged: renderPlayhead
  });

  function bind() {
    $("btn-play").addEventListener("click", playback.toggle);
    $("btn-start").addEventListener("click", () => {
      playback.stop();
      setIndex(0);
    });
    $("btn-end").addEventListener("click", () => {
      playback.stop();
      setIndex(windowLoader.lastIndex());
    });
    $("scrubber").addEventListener("input", (e) => {
      playback.stop();
      setIndex(Number(e.target.value));
    });
    $("hist-track").addEventListener("click", historyTrack.onClick);
    $("window-days").addEventListener("change", () => {
      windowLoader.setWindowDays(Number($("window-days").value) || cfg.windowDays);
      windowLoader.loadLatestWindow().then(() => setIndex(windowLoader.lastIndex()));
    });
  }

  function setIndex(i) {
    windowLoader.setIndex(i);
  }

  function renderPlayhead() {
    const bar = windowLoader.activeBar();
    const bars = windowLoader.bars();
    const index = windowLoader.index();
    if (!bar) return;

    $("bar-info").textContent =
      `${fmtTime(bar.time)}  -  O ${bar.open.toFixed(2)}  H ${bar.high.toFixed(2)}  L ${bar.low.toFixed(2)}  C ${bar.close.toFixed(2)}`;

    const decision = agent.decide(index, bars.slice(0, index + 1));
    $("agent-decision").textContent = `${decision.action} - ${decision.reason}`;
    $("agent-decision").dataset.action = decision.action.toLowerCase();

    $("progress").textContent = `${index + 1} / ${bars.length}`;
    $("scrubber").value = index;
  }

  function setStatus(msg) {
    $("status").textContent = msg;
  }

  function showFatal(err) {
    console.error(err);
    setStatus("Error");
    $("fatal").hidden = false;
    $("fatal").textContent =
      err.message +
      "\n\nStart the python server (python server.py) and open this page through it " +
      "so /api/candles returns real Alpaca 1-min data.\n" +
      "Useful: make /api/data/status return earliest/latest/total counts.";
  }

  return { bind, setIndex, renderPlayhead, setStatus, showFatal };
}
