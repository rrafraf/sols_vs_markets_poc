"use strict";

export function createAgent() {
  return {
    decide(index, bars) {
      void index;
      void bars;
      return { action: "WAIT", reason: "no rule yet" };
    }
  };
}
