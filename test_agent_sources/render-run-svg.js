"use strict";

const fs = require("fs");

function esc(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function pathFor(values, x0, y0, width, height, min, max) {
  if (!values.length) return "";
  const span = max - min || 1;
  return values.map((v, i) => {
    const x = x0 + (i / Math.max(1, values.length - 1)) * width;
    const y = y0 + height - ((v - min) / span) * height;
    return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function renderRunSvg(payload, outPath) {
  const candles = payload.candles || [];
  const result = payload.result || {};
  const equities = (result.equityCurve || []).map((p) => p.equity);
  const prices = candles.map((b) => b.close);

  const W = 1400;
  const H = 800;
  const left = 70;
  const right = 30;
  const plotW = W - left - right;
  const priceY = 70;
  const priceH = 380;
  const eqY = 520;
  const eqH = 200;

  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const eMin = Math.min(...equities);
  const eMax = Math.max(...equities);

  const pricePath = pathFor(prices, left, priceY, plotW, priceH, pMin, pMax);
  const equityPath = pathFor(equities, left, eqY, plotW, eqH, eMin, eMax);

  const xAt = (index) => left + (index / Math.max(1, candles.length - 1)) * plotW;
  const yPrice = (price) => priceY + priceH - ((price - pMin) / (pMax - pMin || 1)) * priceH;

  const markers = (result.events || [])
    .filter((e) => e.type === "ENTRY" || e.type === "EXIT")
    .map((e) => {
      const price = e.type === "ENTRY" ? e.price : e.exit;
      const x = xAt(e.index);
      const y = yPrice(price);
      const label = e.type === "ENTRY" ? `${e.side} entry` : `exit: ${e.reason}`;
      const shape = e.type === "ENTRY"
        ? `<polygon points="${x},${y - 8} ${x - 7},${y + 7} ${x + 7},${y + 7}" fill="currentColor"/>`
        : `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="currentColor" stroke-width="2"/>`;
      return `<g class="${e.type.toLowerCase()}"><title>${esc(label)} @ ${Number(price).toFixed(4)}</title>${shape}</g>`;
    }).join("\n");

  const summary = [
    `seed ${payload.meta?.seed ?? "?"}`,
    `trades ${result.tradeCount ?? 0}`,
    `return ${((result.netReturn || 0) * 100).toFixed(2)}%`,
    `DD ${((result.maxDrawdown || 0) * 100).toFixed(2)}%`,
    `fees $${Number(result.totalFees || 0).toFixed(2)}`
  ].join("  |  ");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
  text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #222; }
  .axis { stroke: #bbb; stroke-width: 1; }
  .price { fill: none; stroke: #222; stroke-width: 1.5; }
  .equity { fill: none; stroke: #555; stroke-width: 1.8; }
  .entry { color: #157f3b; }
  .exit { color: #a12929; }
</style>
<rect width="100%" height="100%" fill="white"/>
<text x="${left}" y="30" font-size="20" font-weight="700">Agent-core diagnostic run</text>
<text x="${left}" y="52" font-size="13">${esc(summary)}</text>
<line class="axis" x1="${left}" y1="${priceY + priceH}" x2="${left + plotW}" y2="${priceY + priceH}"/>
<text x="12" y="${priceY + 20}" font-size="13">PRICE</text>
<path class="price" d="${pricePath}"/>
${markers}
<line class="axis" x1="${left}" y1="${eqY + eqH}" x2="${left + plotW}" y2="${eqY + eqH}"/>
<text x="12" y="${eqY + 20}" font-size="13">EQUITY</text>
<path class="equity" d="${equityPath}"/>
<text x="${left}" y="770" font-size="12">Triangles = entries. Circles = exits. Hover markers in a browser for details. This plot is diagnostic only.</text>
</svg>`;

  fs.writeFileSync(outPath, svg, "utf8");
}

if (require.main === module) {
  const input = process.argv[2];
  const output = process.argv[3] || input?.replace(/\.json$/i, ".svg");
  if (!input || !output) {
    console.error("Usage: node render-run-svg.js <run.json> [out.svg]");
    process.exit(2);
  }
  renderRunSvg(JSON.parse(fs.readFileSync(input, "utf8")), output);
  console.log(output);
}

module.exports = { renderRunSvg };
