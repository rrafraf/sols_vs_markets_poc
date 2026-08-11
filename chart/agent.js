"use strict";

import { agentSensors, marketAt, decide } from "./agent-brain.js";

export function createAgent(sensors = agentSensors) {
  return {
    decide(index, bars) {
      const market = marketAt(index, bars, sensors);
      return decide(market);
    }
  };
}
