"use strict";

export function createTracePanel({ $, dataApi, windowLoader }) {
  let overview = null;
  let activeRun = null;
  let activePayload = null;
  let bookmarks = [];
  let bookmarkIndex = 0;
  let selectedEvidenceIndex = 0;

  async function init() {
    bind();
    await loadOverview();
  }

  function bind() {
    $("trace-refresh")?.addEventListener("click", () => loadOverview());
    $("trace-demo")?.addEventListener("click", () => runDemoTrace());
    $("trace-run")?.addEventListener("change", event => loadRun(event.target.value));
    $("trace-prev")?.addEventListener("click", () => stepBookmark(-1));
    $("trace-next")?.addEventListener("click", () => stepBookmark(1));
  }

  async function runDemoTrace() {
    const button = $("trace-demo");
    try {
      if (button) button.disabled = true;
      setTraceStatus("running fixed demo grind...");
      await dataApi.runTrainingDemo();
      await loadOverview();
    } catch (err) {
      setTraceStatus(`demo failed: ${err.message || err}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function loadOverview() {
    setTraceStatus("loading latest trace...");
    overview = await dataApi.fetchTrainingRuns("latest");
    if (!overview) {
      setTraceStatus("no training trace yet — run .\\RUN-GRIND.ps1");
      return;
    }

    const runSelect = $("trace-run");
    runSelect.innerHTML = "";
    for (const run of overview.runs || []) {
      const option = document.createElement("option");
      option.value = String(run.run);
      option.textContent = `run ${run.run}  ${pct(run.netReturn)}  anom ${run.anomalyCount ?? 0}`;
      runSelect.appendChild(option);
    }

    const anomalyRun = (overview.runs || []).find(run => Number(run.anomalyCount) > 0);
    const defaultRun = anomalyRun?.run ?? overview.best?.run ?? overview.runs?.[0]?.run;
    if (defaultRun != null) {
      runSelect.value = String(defaultRun);
      await loadRun(String(defaultRun));
    } else {
      renderOverviewOnly();
    }
  }

  async function loadRun(run) {
    activeRun = String(run);
    setTraceStatus(`loading run ${activeRun}...`);
    activePayload = await dataApi.fetchTrainingRun({ name: "latest", run: activeRun });
    if (!activePayload) {
      setTraceStatus(`could not load run ${activeRun}`);
      return;
    }

    bookmarks = buildBookmarks(activePayload);
    bookmarkIndex = 0;
    render();
    if (bookmarks.length) selectBookmark(0, { jump: false });
  }

  function renderOverviewOnly() {
    $("trace-summary").textContent = "No runs found in latest training output.";
    $("trace-story").textContent = "Run .\\RUN-GRIND.ps1 first.";
    $("trace-human").innerHTML = renderNoTraceCards();
    $("trace-events").innerHTML = "";
    $("trace-anomalies").innerHTML = "";
  }

  function render() {
    const run = activePayload.summary || {};
    const manifest = activePayload.manifest || {};
    const events = activePayload.events || [];
    const trades = activePayload.trades || [];
    const anomalies = activePayload.anomalies || [];
    const decisions = activePayload.decisions || [];
    selectedEvidenceIndex = Math.max(0, Math.min(selectedEvidenceIndex, Math.max(0, anomalies.length - 1)));
    const selectedEvidence = anomalies[selectedEvidenceIndex] || null;

    $("trace-summary").textContent = [
      `run ${activeRun}`,
      `git ${manifest.gitSha || "?"}${manifest.gitDirty ? " dirty" : ""}`,
      `return ${pct(run.netReturn)}`,
      `trades ${trades.length}`,
      `events ${events.length}`,
      `decisions ${decisions.length}`,
      `anomalies ${anomalies.length}`
    ].join(" · ");

    $("trace-human").innerHTML = renderHumanStory(activePayload, selectedEvidence);
    $("trace-story").innerHTML = renderCaseReport(activePayload, selectedEvidence);
    $("trace-events").innerHTML = renderEventRows(eventsForDisplay(events, selectedEvidence ? [selectedEvidence] : anomalies));
    $("trace-anomalies").innerHTML = renderAnomalyRows(anomalies, selectedEvidenceIndex);
    setTraceStatus("ready");

    for (const row of document.querySelectorAll("[data-trace-time]")) {
      row.addEventListener("click", () => jumpToTraceTime(row.dataset.traceTime));
    }
    for (const row of document.querySelectorAll("[data-evidence-index]")) {
      row.addEventListener("click", () => selectEvidence(Number(row.dataset.evidenceIndex), { jump: true }));
    }
  }

  function renderEventRows(events) {
    if (!events.length) return `<div class="trace-empty">no events</div>`;
    return events.slice(0, 180).map(event => `
      <button class="trace-row trace-event-row" data-event-type="${esc(event.type)}" data-phase="${esc(event.phase || "")}" data-trace-time="${esc(event.time)}" type="button">
        <span class="trace-index">#${esc(event.index)}</span>
        <span>${shortTime(event.time)}</span>
        <span>
          <b class="event-chip">${esc(eventLabel(event.type))}</b>
          <small>${esc(event.phase ? `${event.phase} / ${event.type}` : event.type)}</small>
        </span>
        <span>${esc(eventActor(event))}</span>
        <span>${esc(humanEvent(event))}</span>
      </button>
    `).join("");
  }

  function eventsForDisplay(events, anomalies) {
    if (!anomalies.length) return events.slice(0, 180);

    const wantedIndexes = new Set();
    for (const anomaly of anomalies) {
      const index = Number(anomaly.index);
      if (!Number.isFinite(index)) continue;
      wantedIndexes.add(index - 2);
      wantedIndexes.add(index - 1);
      wantedIndexes.add(index);
      wantedIndexes.add(index + 1);
      wantedIndexes.add(index + 2);
    }

    const focused = events.filter(event => wantedIndexes.has(Number(event.index)));
    return (focused.length ? focused : events).slice(0, 180);
  }

  function renderAnomalyRows(anomalies, selectedIndex) {
    if (!anomalies.length) return `<div class="trace-empty">no anomalies for this run</div>`;
    return anomalies.map((anomaly, index) => `
      <button class="trace-row trace-anomaly" data-evidence-index="${index}" aria-pressed="${index === selectedIndex ? "true" : "false"}" type="button">
        <span>${esc(anomaly.index)}</span>
        <span>${shortTime(anomaly.time)}</span>
        <span>${esc(anomaly.type)}</span>
        <span>CASE ${index + 1}</span>
        <span>${esc(anomaly.message || "")}</span>
      </button>
    `).join("");
  }

  function renderCaseReport(payload, evidence) {
    if (!evidence) {
      return `<div class="case-report"><div class="trace-empty">No evidence case selected.</div></div>`;
    }

    const idx = String(evidence.index);
    const events = payload.events || [];
    const sameIndexEvents = events.filter(e => String(e.index) === idx);
    const submitted = events.find(event =>
      event.type === "ORDER_SUBMITTED" &&
      event.agentId === evidence.agentId &&
      String(event.fillIndex) === idx
    );
    const filled = sameIndexEvents.find(event => event.type === "ORDER_FILLED");
    const exit = sameIndexEvents.find(event => event.type === "EXIT");
    const blocked = sameIndexEvents.find(event => event.type === "DECISION_BLOCKED");
    const details = sameCandleDetails(evidence);
    const side = details.side || filled?.side || submitted?.side || "unknown";
    const exitReason = details.exitReason || exit?.reason || "unknown";
    const title = evidenceTitle(evidence, filled, exit);

    return `
      <div class="case-report">
        <div class="case-hero">
          <div>
            <div class="case-kicker">CASE ${selectedEvidenceIndex + 1} · ${esc(evidence.type)}</div>
            <h3>${esc(title)}</h3>
            <p>${esc(evidence.message || "The trace found an execution event that needs inspection.")}</p>
          </div>
          <div class="case-verdict">
            <span>current verdict</span>
            <strong>${blocked ? "contained" : "visible"}</strong>
          </div>
        </div>
        <div class="case-facts">
          ${caseFact("agent", evidence.agentId || submitted?.agentId || "?")}
          ${caseFact("candle", `#${idx}`)}
          ${caseFact("time", shortTime(evidence.time))}
          ${caseFact("side", side)}
          ${caseFact("exit", exitReason)}
          ${caseFact("pnl", exit ? money(exit.pnl) : "?")}
        </div>
        <div class="case-timeline" aria-label="case timeline">
          ${caseStep(1, "intent", submitted
            ? `${submitted.agentId} asked for ${submitted.action}. Fill target: candle ${submitted.fillIndex}.`
            : `${evidence.agentId} had an entry order before candle ${idx}.`, "intent")}
          ${caseStep(2, "fill", filled
            ? `Position opened at ${money(filled.price)} on ${shortTime(filled.time)}.`
            : `The simulator opened a position on candle ${idx}.`, "fill")}
          ${caseStep(3, "collision", exit
            ? `The same candle also closed it by ${exit.reason}, at ${money(exit.price)}.`
            : "The same candle also triggered an exit.", "danger")}
          ${caseStep(4, "inspection", `OHLC gives open/high/low/close, but not the true order of events inside the minute.`, "inspect")}
          ${caseStep(5, "responsibility", `Layer: execution model / intrabar assumptions. Not a trader-brain bug.`, "report")}
          ${caseStep(6, "measure", blocked
            ? "Anomaly recorded; later same-candle decision was blocked."
            : "Anomaly recorded for inspection.", "measure")}
        </div>
        <div class="case-status">
          <strong>Meaning:</strong>
          The trace is useful because it makes this uncertainty explicit instead of silently scoring the trade as clean.
        </div>
      </div>
    `;
  }

  function renderHumanStory(payload, evidence) {
    const run = payload.summary || {};
    if (!evidence) {
      return [
        card("Evidence room", `Run ${payload.run} completed ${run.tradeCount ?? "?"} trades.`, "No evidence case is selected in this run."),
        card("How to inspect", "Pick a case from the evidence list.", "The event log on the right stays as the raw proof.")
      ].join("");
    }

    const events = payload.events || [];
    const idx = String(evidence.index);
    const sameIndexEvents = events.filter(event => String(event.index) === idx);
    const filled = sameIndexEvents.find(event => event.type === "ORDER_FILLED");
    const exit = sameIndexEvents.find(event => event.type === "EXIT");
    const blocked = sameIndexEvents.find(event => event.type === "DECISION_BLOCKED");
    const submitted = events.find(event =>
      event.type === "ORDER_SUBMITTED" &&
      event.agentId === evidence.agentId &&
      String(event.fillIndex) === idx
    );
    const sequence = sameIndexEvents.map(event => event.type).join(" → ");
    const side = sameCandleDetails(evidence).side || filled?.side || submitted?.side || "position";
    const submitText = submitted
      ? `${submitted.agentId} decided ${submitted.action} at ${shortTime(submitted.time)}.`
      : `${evidence.agentId} had an entry order before this candle.`;
    const fillText = filled
      ? `The simulator filled ${side} at ${money(filled.price)} on ${shortTime(filled.time)}.`
      : `The simulator filled ${side} on candle ${idx}.`;
    const exitText = exit
      ? `The stop/exit also fired on that same candle, closing at ${money(exit.price)} for ${money(exit.pnl)}.`
      : "The exit also fired on that same candle.";
    const blockText = blocked
      ? "A same-candle re-decision was blocked after the open+close collision."
      : "The anomaly was recorded for inspection.";

    return [
      card("Selected evidence", `Case ${selectedEvidenceIndex + 1}: ${evidence.type}`, `Candle ${idx} · ${shortTime(evidence.time)}`),
      card("Incident", `${submitText} ${fillText} ${exitText}`, "This is the readable summary; the event log is the proof."),
      card("Candle malfunction", "The trade entered and exited inside one 1-minute OHLC candle.", "OHLC does not prove which intraminute event came first."),
      card("Investigation", blockText, `Observed sequence: ${sequence || "no same-index events"}`)
    ].join("");
  }

  function caseStep(number, title, text, tone) {
    return `
      <div class="case-step" data-tone="${esc(tone)}">
        <strong>${number}</strong>
        <div>
          <span>${esc(title)}</span>
          <p>${esc(text)}</p>
        </div>
      </div>
    `;
  }

  function caseFact(label, value) {
    return `
      <div class="case-fact">
        <span>${esc(label)}</span>
        <strong>${esc(value)}</strong>
      </div>
    `;
  }

  function renderNoTraceCards() {
    return [
      card("No trace loaded", "Run a grind once, then the app can explain it here.", "Use the demo trace button or the RUN-GRIND script."),
      card("Goal", "Turn raw backtest internals into a readable story.", "The raw rows stay available as evidence.")
    ].join("");
  }

  function card(title, main, note) {
    return `
      <div class="trace-card">
        <div class="trace-card-title">${esc(title)}</div>
        <div class="trace-card-main">${esc(main)}</div>
        <div class="trace-card-note">${esc(note)}</div>
      </div>
    `;
  }

  function humanEvent(event) {
    if (event.type === "ORDER_SUBMITTED") {
      return `${eventActor(event)} asked for ${event.action}; fill scheduled for candle ${event.fillIndex}.`;
    }
    if (event.type === "ORDER_FILLED") {
      return `${event.side} opened at ${money(event.price)}.`;
    }
    if (event.type === "EXIT_DECISION") {
      return `exit condition fired: ${event.reason}.`;
    }
    if (event.type === "EXIT") {
      return `${event.side} closed at ${money(event.price)}; pnl ${money(event.pnl)}.`;
    }
    if (event.type === "DECISION_BLOCKED") {
      return `new decision blocked: ${event.reason}.`;
    }
    return `${event.type}: ${event.action || event.reason || ""}`;
  }

  function eventActor(event) {
    return event.agentId || event.side || event.action || "";
  }

  function eventLabel(type) {
    if (type === "ORDER_SUBMITTED") return "intent";
    if (type === "ORDER_FILLED") return "fill";
    if (type === "EXIT_DECISION") return "exit signal";
    if (type === "EXIT") return "exit";
    if (type === "DECISION_BLOCKED") return "blocked";
    return String(type || "event").toLowerCase().replaceAll("_", " ");
  }

  function evidenceTitle(evidence, filled, exit) {
    if (evidence.type === "ENTRY_EXIT_SAME_CANDLE") {
      return "Trade opened and closed inside one candle";
    }
    if (evidence.type === "INTRABAR_EXIT_AMBIGUITY") {
      return "Exit depends on unknown intrabar order";
    }
    if (filled && exit) {
      return "Execution needs inspection";
    }
    return "Trace anomaly";
  }

  function sameCandleDetails(anomaly) {
    try {
      return JSON.parse(anomaly.details || "{}");
    } catch {
      return {};
    }
  }

  function buildBookmarks(payload) {
    const items = [];
    for (const anomaly of payload.anomalies || []) {
      items.push({ time: anomaly.time, label: anomaly.type });
    }
    for (const event of payload.events || []) {
      if (["ORDER_SUBMITTED", "ORDER_FILLED", "EXIT", "DECISION_BLOCKED"].includes(event.type)) {
        items.push({ time: event.time, label: event.type });
      }
    }
    return items.filter(item => item.time);
  }

  function stepBookmark(delta) {
    if (!bookmarks.length) return;
    selectBookmark(bookmarkIndex + delta, { jump: true });
  }

  function selectBookmark(index, { jump }) {
    bookmarkIndex = Math.max(0, Math.min(bookmarks.length - 1, index));
    const item = bookmarks[bookmarkIndex];
    $("trace-bookmark").textContent = `${bookmarkIndex + 1}/${bookmarks.length} ${item.label} ${shortTime(item.time)}`;
    if (jump) jumpToTraceTime(item.time);
  }

  async function jumpToTraceTime(isoTime) {
    const t = Math.floor(Date.parse(isoTime) / 1000);
    if (!Number.isFinite(t)) return;
    setTraceStatus(`jump ${shortTime(isoTime)}`);
    await windowLoader.loadWindowEndingAt(t);
  }

  function setTraceStatus(text) {
    const node = $("trace-status");
    if (node) node.textContent = text;
  }

  function selectEvidence(index, { jump = false } = {}) {
    selectedEvidenceIndex = Math.max(0, Math.min(index, (activePayload?.anomalies || []).length - 1));
    const evidence = activePayload?.anomalies?.[selectedEvidenceIndex];
    render();
    if (jump && evidence?.time) jumpToTraceTime(evidence.time);
  }

  return { init, loadOverview, loadRun };
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "?";
}

function shortTime(value) {
  if (!value) return "";
  return String(value).replace("T", " ").replace("Z", "");
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  return `$${n.toFixed(2)}`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
