"use strict";

export function createDataApi(cfg) {
  async function fetchMeta() {
    try {
      const params = new URLSearchParams({
        symbol: cfg.symbol,
        timeframe: cfg.timeframe
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
      symbol: cfg.symbol,
      timeframe: cfg.timeframe
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

  async function fetchAgentGrind() {
    const res = await fetch("/api/agent/grind");
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchTrainingRuns(name = "latest") {
    const params = new URLSearchParams({ name });
    const res = await fetch(`/api/training/runs?${params}`);
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchTrainingRun({ name = "latest", run } = {}) {
    const params = new URLSearchParams({ name });
    if (run != null) params.set("run", String(run));
    const res = await fetch(`/api/training/run?${params}`);
    if (!res.ok) return null;
    return res.json();
  }

  async function runTrainingDemo() {
    const res = await fetch("/api/training/demo", { method: "POST" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    return payload;
  }

  return {
    fetchMeta,
    fetchBars,
    fetchAgentGrind,
    fetchTrainingRuns,
    fetchTrainingRun,
    runTrainingDemo
  };
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
