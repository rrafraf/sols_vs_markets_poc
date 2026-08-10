"use strict";

import { CFG } from "./chart/config.js";
import { createAgent } from "./chart/agent.js";
import { createDataApi } from "./chart/data-api.js";
import { createPriceChart } from "./chart/price-chart.js";
import { createWindowLoader } from "./chart/window-loader.js";
import { createPlayback } from "./chart/playback.js";
import { createHistoryTrack } from "./chart/history-track.js";
import { createTradeOverlay } from "./chart/trade-overlay.js";
import { agentSensors } from "./chart/agent-brain.js";
import { createUi } from "./chart/ui.js";

const $ = (id) => document.getElementById(id);

const agent = createAgent();
const dataApi = createDataApi(CFG);
const priceChart = createPriceChart({ $, chartsLib: window.LightweightCharts });
const windowLoader = createWindowLoader({ $, cfg: CFG, dataApi, priceChart });
const playback = createPlayback({ $, windowLoader });
const historyTrack = createHistoryTrack({ $, windowLoader, playback });
const tradeOverlay = createTradeOverlay({ dataApi, priceChart, windowLoader });
const ui = createUi({ $, cfg: CFG, agent, priceChart, windowLoader, playback, historyTrack, tradeOverlay });

async function main() {
  try {
    ui.setStatus("Connecting...");

    const meta = await dataApi.fetchMeta();
    windowLoader.setMeta(meta);
    historyTrack.setMeta(meta);

    priceChart.init();
    for (const sensor of agentSensors) {
      priceChart.add_sensor(sensor.fn, {
        name: sensor.name,
        color: sensor.color,
        ...(sensor.options || {})
      });
    }
    await tradeOverlay.load();
    ui.bind();

    if (meta) {
      $("hist-wrap").hidden = false;
      historyTrack.update();
    }

    await windowLoader.loadLatestWindow();
    ui.setIndex(windowLoader.lastIndex());
  } catch (err) {
    ui.showFatal(err);
  }
}

main();
