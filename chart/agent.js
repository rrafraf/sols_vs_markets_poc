"use strict";

import { agentSensors, momentAt, decide } from "./agent-brain.js";

export function createAgent(sensors = agentSensors) {
  return {
    decide(index, bars) {
      const moment = momentAt(index, bars, sensors);
      return decide(moment);
    }
  };
}
