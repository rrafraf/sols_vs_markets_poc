"use strict";

import { isEntryAction } from "./actions.js";
import { fmtTime } from "./format.js";

export function createUi({ $, cfg, agent, priceChart, windowLoader, playback, historyTrack, tradeOverlay }) {
  windowLoader.subscribe({
    status: setStatus,
    windowChanged: () => {
      historyTrack.update();
      tradeOverlay.render();
    },
    indexChanged: () => {
      tradeOverlay.render();
      renderPlayhead();
    }
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
    $("btn-prev-event").addEventListener("click", () => {
      playback.stop();
      const index = tradeOverlay.previousEventIndex(windowLoader.index());
      if (index != null) setIndex(index);
    });
    $("btn-next-event").addEventListener("click", () => {
      playback.stop();
      const index = tradeOverlay.nextEventIndex(windowLoader.index());
      if (index != null) setIndex(index);
    });
    $("btn-stress-minus").addEventListener("click", () => updateStress(tradeOverlay.adjustStressOffset(-1)));
    $("btn-stress-plus").addEventListener("click", () => updateStress(tradeOverlay.adjustStressOffset(1)));
    $("btn-stress-reset").addEventListener("click", () => updateStress(tradeOverlay.resetStressOffset()));
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
    priceChart.setHead(bar);

    $("bar-info").textContent =
      `${fmtTime(bar.time)}  -  O ${bar.open.toFixed(2)}  H ${bar.high.toFixed(2)}  L ${bar.low.toFixed(2)}  C ${bar.close.toFixed(2)}`;

    const decision = agent.decide(index, bars.slice(0, index + 1));
    const grindDecision = tradeOverlay.explain(bar);
    $("agent-decision").textContent = grindDecision
      ? `${decision.action} - ${decision.reason} | tester: ${grindDecision.action} ${grindDecision.reason}`
      : `${decision.action} - ${decision.reason}`;
    $("agent-decision").dataset.action = decision.action.toLowerCase();
    $("agent-inputs").textContent = formatDecisionInputs(decision.inputs);
    $("agent-meta").textContent = formatDecisionMeta(decision);
    priceChart.setMarkerLayer("agent-decision", decisionMarker(decision, bar));

    $("progress").textContent = `${index + 1} / ${bars.length}`;
    $("scrubber").value = index;
    updateDebugState();
  }

  function setStatus(msg) {
    $("status").textContent = msg;
  }

  function updateStress(offset) {
    updateDebugState(offset);
  }

  function updateDebugState(offset = tradeOverlay.stressOffset()) {
    const index = windowLoader.index();
    $("playhead-debug").textContent = `head ${index + 1} - stress ${offset}`;
  }

  function decisionMarker(decision, bar) {
    if (!bar || !isEntryAction(decision.action)) return [];
    return [{
      time: bar.time,
      position: decision.action === "LONG" ? "belowBar" : "aboveBar",
      color: decision.action === "LONG" ? "#3fb950" : "#f85149",
      shape: decision.action === "LONG" ? "arrowUp" : "arrowDown",
      text: `AGENT ${decision.action}`
    }];
  }

  function formatDecisionInputs(inputs) {
    const entries = Object.entries(inputs || {});
    if (!entries.length) return "inputs —";
    return entries
      .map(([key, value]) => `${key} ${formatInputValue(value)}`)
      .join(" | ");
  }

  function formatInputValue(value) {
    return Number.isFinite(value) ? value.toFixed(3) : "n/a";
  }

  function formatDecisionMeta(decision) {
    const parts = [];
    if (decision.belief) {
      parts.push(
        `belief L ${formatInputValue(decision.belief.long)} S ${formatInputValue(decision.belief.short)}`,
        `conv ${formatInputValue(decision.belief.conviction)}`,
        `struggle ${formatInputValue(decision.belief.struggle)}`
      );
    }
    if (decision.drive) {
      parts.push(
        `drive ${decision.drive.dominant}`,
        `greed ${formatInputValue(decision.drive.greed)}`,
        `fear ${formatInputValue(decision.drive.fear)}`,
        `joy ${formatInputValue(decision.drive.joy)}`,
        `patience ${formatInputValue(decision.drive.patience)}`
      );
    }
    if (decision.memory) {
      const winRate = decision.memory.winRate == null
        ? "n/a"
        : `${(decision.memory.winRate * 100).toFixed(0)}%`;
      parts.push(
        `memory n ${decision.memory.samples}`,
        `avg ${formatInputValue(decision.memory.avgBps)}bps`,
        `win ${winRate}`,
        `trauma ${formatInputValue(decision.memory.trauma)}`
      );
    }
    if (decision.risk) {
      parts.push(
        `risk bad ${formatInputValue(decision.risk.expectedAdverseBps)}bps`,
        `worst ${formatInputValue(decision.risk.worstAdverseBps)}bps`,
        `severity ${formatInputValue(decision.risk.severity)}`
      );
    }
    if (decision.size) {
      parts.push(`size ${(decision.size.equityFraction * 100).toFixed(3)}% equity`);
    }
    if (decision.veto) {
      parts.push(`veto ${decision.veto}`);
    }
    return parts.length ? parts.join(" | ") : "belief —";
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
