"use strict";

// Example shape only. Replace with your own function.
export function closeChangeSensor(bars) {
  return bars.map((bar, index) => {
    if (index === 0) return null;
    const prev = bars[index - 1].close;
    return {
      time: bar.time,
      value: (bar.close - prev) / prev
    };
  });
}

closeChangeSensor.indicator = {
  name: "close change",
  pane: "separate",
  color: "#58a6ff",
  lineWidth: 1
};
