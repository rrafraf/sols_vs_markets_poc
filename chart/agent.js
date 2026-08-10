"use strict";

import { agentSensors, buildDecisionState, decide } from "./agent-brain.js";

export function createAgent(sensors = agentSensors) {
  return {
    decide(index, bars) {
      return decide(buildDecisionState(index, bars, sensors));
    }
  };
}
