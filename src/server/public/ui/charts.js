// @ts-check
/**
 * History timeline: one time axis, three lanes.
 *
 *   verdict band   what Token Finder concluded, coloured by verdict, with a
 *                  marker at every change
 *   price          as observed at each stored snapshot
 *   liquidity      as observed at each stored snapshot
 *
 * Observations are irregular - snapshots are stored on change, transition or a
 * heartbeat, not on a clock - so points are drawn where they were observed and
 * joined, never resampled into invented candles.
 *
 * Pure SVG attributes, no inline style, so the strict CSP holds. Hover detail is
 * attached by `attachTimeline` after render.
 */

import { html } from '../lib/html.js';
import { clock, price, usd, when } from '../lib/format.js';

/**
 * @typedef {{ t: number, score: number, coverage: number | null, eligibility: string | null, transition: boolean }} VerdictPoint
 * @typedef {{ t: number, price: number | null, liquidity: number | null, volume: number | null }} MarketPoint
 * @typedef {{ at: number, kind: string, from: string | null, to: string | null, reason: string }} Change
 */

const LANE = { bandTop: 8, bandHeight: 14, priceTop: 40, priceHeight: 78, liqTop: 140, liqHeight: 56, axisY: 214 };
export const TIMELINE_HEIGHT = 232;
const PAD_LEFT = 8;
const PAD_RIGHT = 64;

const TONE = /** @type {Record<string, string>} */ ({
  QUALIFIED: 'good',
  WATCH: 'warn',
  INSUFFICIENT_DATA: 'neutral',
  REJECTED: 'bad',
});

/**
 * @param {number[]} values
 * @returns {{ min: number, max: number }}
 */
function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/**
 * A gap in observation longer than this is drawn as a gap. Snapshots are stored
 * at least every 30 minutes while a token is scanned (the heartbeat), so two
 * hours without one means nobody was looking - joining the points would draw a
 * price path that was never observed.
 */
const GAP_MS = 2 * 3_600_000;

/**
 * @param {{ t: number, v: number | null }[]} points
 * @param {(t: number) => number} x
 * @param {number} top @param {number} height
 */
function linePath(points, x, top, height) {
  const known = points.filter((p) => p.v !== null && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (known.length === 0) return { path: '', dots: [], range: null, gaps: [] };
  const range = extent(known.map((p) => /** @type {number} */ (p.v)));
  const y = (/** @type {number} */ v) => top + height - ((v - range.min) / (range.max - range.min)) * height;
  const coords = known.map((p) => ({ t: p.t, x: x(p.t), y: y(/** @type {number} */ (p.v)) }));
  /** @type {{ x0: number, x1: number }[]} */
  const gaps = [];
  const path = coords
    .map((c, i) => {
      const previous = coords[i - 1];
      const broken = previous !== undefined && c.t - previous.t > GAP_MS;
      if (broken) gaps.push({ x0: previous.x, x1: c.x });
      return `${i === 0 || broken ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`;
    })
    .join(' ');
  return { path, dots: known.length <= 48 ? coords : [], range, gaps };
}

/** Nice time ticks across a span. @param {number} t0 @param {number} t1 */
function ticks(t0, t1, count = 5) {
  const span = t1 - t0;
  if (span <= 0) return [t0];
  const step = span / count;
  return Array.from({ length: count + 1 }, (_, i) => t0 + i * step);
}

/** @param {number} t @param {number} span */
function tickLabel(t, span) {
  if (span < 36 * 3_600_000) return clock(t);
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * @param {{ verdicts: VerdictPoint[], market: MarketPoint[], changes: Change[] }} data
 * @param {number} width
 */
export function timeline(data, width) {
  const times = [...data.verdicts.map((p) => p.t), ...data.market.map((p) => p.t)];
  if (times.length === 0) return html``;
  const w = Math.max(280, Math.round(width));
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  if (t1 - t0 < 60_000) {
    t0 -= 30 * 60_000;
    t1 += 30 * 60_000;
  }
  const plotW = w - PAD_LEFT - PAD_RIGHT;
  const x = (/** @type {number} */ t) => PAD_LEFT + ((t - t0) / (t1 - t0)) * plotW;

  // Verdict band: each assessed point holds until the next one.
  const verdicts = [...data.verdicts].sort((a, b) => a.t - b.t);
  const band = verdicts.map((point, index) => {
    const next = verdicts[index + 1];
    const x0 = x(point.t);
    const x1 = next ? x(next.t) : PAD_LEFT + plotW;
    const tone = point.eligibility ? TONE[point.eligibility] ?? 'neutral' : 'none';
    return html`<rect class="band band--${tone}" x="${x0.toFixed(1)}" y="${LANE.bandTop}" width="${Math.max(1.5, x1 - x0).toFixed(1)}" height="${LANE.bandHeight}"></rect>`;
  });

  const priceLine = linePath(data.market.map((p) => ({ t: p.t, v: p.price })), x, LANE.priceTop, LANE.priceHeight);
  const liqLine = linePath(data.market.map((p) => ({ t: p.t, v: p.liquidity })), x, LANE.liqTop, LANE.liqHeight);

  const markers = data.changes
    .filter((change) => change.kind === 'changed' && change.at >= t0 && change.at <= t1)
    .map((change) => {
      const cx = x(change.at);
      const tone = change.to ? TONE[change.to] ?? 'neutral' : 'neutral';
      return html`<g class="marker marker--${tone}">
        <line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${LANE.bandTop}" y2="${LANE.liqTop + LANE.liqHeight}"></line>
        <path d="${`M${cx.toFixed(1)},${LANE.bandTop - 5} l5,5 l-5,5 l-5,-5 z`}"></path>
      </g>`;
    });

  const span = t1 - t0;
  const allTicks = ticks(t0, t1, w < 520 ? 3 : 5);
  let previousLabel = '';
  const tickMarks = allTicks.map((t, index) => {
    const label = tickLabel(t, span);
    if (label === previousLabel) return '';
    previousLabel = label;
    // Edge labels anchor inward so the frame never clips them.
    const anchor = index === 0 ? 'start' : index === allTicks.length - 1 ? 'end' : 'middle';
    return html`<text class="axis__label" x="${x(t).toFixed(1)}" y="${LANE.axisY + 12}" text-anchor="${anchor}">${label}</text>`;
  });

  // Unobserved stretches, shaded across both market lanes.
  const gapShades = [...priceLine.gaps, ...liqLine.gaps]
    .filter((gap, index, list) => list.findIndex((g) => Math.abs(g.x0 - gap.x0) < 1) === index)
    .map((gap) => html`<rect class="gap" x="${gap.x0.toFixed(1)}" y="${LANE.priceTop}" width="${Math.max(1, gap.x1 - gap.x0).toFixed(1)}" height="${LANE.liqTop + LANE.liqHeight - LANE.priceTop}"></rect>`);

  const rangeLabel = (/** @type {{ min: number, max: number } | null} */ range, top, height, fmt) =>
    range
      ? html`<text class="axis__value" x="${w - PAD_RIGHT + 6}" y="${top + 8}">${fmt(range.max)}</text>
             <text class="axis__value" x="${w - PAD_RIGHT + 6}" y="${top + height}">${fmt(range.min)}</text>`
      : html`<text class="axis__value axis__value--none" x="${w - PAD_RIGHT + 6}" y="${top + height / 2 + 4}">no data</text>`;

  return html`<svg class="timeline" viewBox="0 0 ${w} ${TIMELINE_HEIGHT}" width="${w}" height="${TIMELINE_HEIGHT}" role="img"
      aria-label="Verdict, price and liquidity over time, from ${when(t0)} to ${when(t1)}"
      data-t0="${t0}" data-t1="${t1}" data-pad-left="${PAD_LEFT}" data-plot-w="${plotW}">
    <text class="lane__label" x="${PAD_LEFT}" y="${LANE.priceTop - 6}">Price</text>
    <text class="lane__label" x="${PAD_LEFT}" y="${LANE.liqTop - 6}">Liquidity</text>
    <line class="grid" x1="${PAD_LEFT}" x2="${w - PAD_RIGHT}" y1="${LANE.priceTop + LANE.priceHeight}" y2="${LANE.priceTop + LANE.priceHeight}"></line>
    <line class="grid" x1="${PAD_LEFT}" x2="${w - PAD_RIGHT}" y1="${LANE.liqTop + LANE.liqHeight}" y2="${LANE.liqTop + LANE.liqHeight}"></line>
    ${gapShades}
    ${band}
    ${markers}
    ${priceLine.path ? html`<path class="line line--price" d="${priceLine.path}"></path>` : ''}
    ${priceLine.dots.map((c) => html`<circle class="dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="1.8"></circle>`)}
    ${liqLine.path ? html`<path class="line line--liq" d="${liqLine.path}"></path>` : ''}
    ${liqLine.dots.map((c) => html`<circle class="dot dot--liq" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="1.8"></circle>`)}
    ${rangeLabel(priceLine.range, LANE.priceTop, LANE.priceHeight, price)}
    ${rangeLabel(liqLine.range, LANE.liqTop, LANE.liqHeight, usd)}
    ${tickMarks}
    <line class="crosshair" x1="0" x2="0" y1="${LANE.bandTop}" y2="${LANE.axisY}" visibility="hidden"></line>
  </svg>`;
}

/**
 * Pointer readout: nearest observation to the pointer, written into `readout`.
 *
 * @param {HTMLElement} container
 * @param {{ verdicts: VerdictPoint[], market: MarketPoint[] }} data
 * @param {HTMLElement} readout
 * @param {(point: { t: number, verdict: VerdictPoint | null, market: MarketPoint | null }) => import('../lib/html.js').SafeHtml} describe
 * @param {(el: Element, fragment: import('../lib/html.js').SafeHtml) => void} paint
 */
export function attachTimeline(container, data, readout, describe, paint) {
  const svg = container.querySelector('svg.timeline');
  if (!(svg instanceof SVGSVGElement)) return;
  const t0 = Number(svg.dataset.t0);
  const t1 = Number(svg.dataset.t1);
  const padLeft = Number(svg.dataset.padLeft);
  const plotW = Number(svg.dataset.plotW);
  const crosshair = svg.querySelector('.crosshair');
  const verdicts = [...data.verdicts].sort((a, b) => a.t - b.t);
  const market = [...data.market].sort((a, b) => a.t - b.t);

  /** @template {{ t: number }} P @param {P[]} points @param {number} t */
  const nearestBefore = (points, t) => {
    let best = null;
    for (const point of points) {
      if (point.t <= t) best = point;
      else break;
    }
    return best ?? points[0] ?? null;
  };
  /** @template {{ t: number }} P @param {P[]} points @param {number} t */
  const nearest = (points, t) => {
    let best = null;
    let distance = Infinity;
    for (const point of points) {
      const d = Math.abs(point.t - t);
      if (d < distance) {
        distance = d;
        best = point;
      }
    }
    return best;
  };

  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / box.width;
    const px = (event.clientX - box.left) * scale;
    const ratio = Math.max(0, Math.min(1, (px - padLeft) / plotW));
    const t = t0 + ratio * (t1 - t0);
    const m = nearest(market, t);
    const at = m ? m.t : t;
    const cx = padLeft + ((at - t0) / (t1 - t0)) * plotW;
    crosshair?.setAttribute('x1', cx.toFixed(1));
    crosshair?.setAttribute('x2', cx.toFixed(1));
    crosshair?.setAttribute('visibility', 'visible');
    paint(readout, describe({ t: at, verdict: nearestBefore(verdicts, at), market: m }));
  });
  svg.addEventListener('pointerleave', () => {
    crosshair?.setAttribute('visibility', 'hidden');
    paint(readout, describe({ t: NaN, verdict: null, market: null }));
  });
}
