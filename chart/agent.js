"use strict";

import { agentSensors, buildDecisionFrame, decide } from "./agent-brain.js";

export function createAgent(sensors = agentSensors) {
  return {
    decide(index, bars) {
      return decide(buildDecisionFrame(index, bars, sensors));
    }
  };
}
