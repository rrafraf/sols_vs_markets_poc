"use strict";

export const ACTION = Object.freeze({
  LONG: "LONG",
  SHORT: "SHORT",
  HOLD: "HOLD",
  WAIT: "WAIT"
});

export function cleanAction(value) {
  const raw = String(value || ACTION.HOLD).toUpperCase();
  return Object.values(ACTION).includes(raw) ? raw : ACTION.HOLD;
}

export function isEntryAction(value) {
  const action = cleanAction(value);
  return action === ACTION.LONG || action === ACTION.SHORT;
}
