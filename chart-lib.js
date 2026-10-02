// ── CHARTS ─────────────────────────────────────────────────────────────────────
// Tiny hand-rolled SVG chart helpers for the charts page. No dependencies.
// Each returns an SVG string on a fixed viewBox; CSS scales it to the container
// width. Colors come from theme CSS variables so light/dark both work. Values
// interpolated into markup are escaped via _esc (db.js).

const Charts = (() => {
  const W = 440, H = 280;   // logical viewBox; CSS scales it to fit the card

  function wrap(inner, { w = W, h = H, cls = '' } = {}) {
    return `<svg class="chart-svg${cls ? ' ' + cls : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
  }
  function empty() {
    return wrap(`<text x="${W / 2}" y="${H / 2}" class="ch-empty" text-anchor="middle" dominant-baseline="middle">No data</text>`);
  }

  // Interactive shape attributes: a class + data-* the page reads to pin a
  // caption ("name | meta") on tap, with an optional link. Every clickable shape
  // (bar, dot, arc, cell) gets these so all charts behave like the scatter.
  function hit(name, meta, href, cls) {
    let a = ` class="ch-hit${cls ? ' ' + cls : ''}" data-name="${_esc(name == null ? '' : name)}" data-meta="${_esc(meta == null ? '' : meta)}"`;
    if (href) a += ` data-href="${_esc(href)}"`;
    return a;
  }
  function titleText(name, meta) { return _esc(meta ? name + ': ' + meta : (name == null ? '' : String(name))); }

  // Sequential indigo ramp for ordinal categories (e.g. table sizes). Deliberately
  // avoids the pace colors (green/yellow/orange/red) so slices are not misread as
  // a pace band.
  const PALETTE = ['#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b'];

  // "Nice" axis ticks: a round step (1 / 2 / 2.5 / 5 x 10^n) so labels land on
  // tidy values (0 500 1000 1500 2000 rather than 0 463 925 ...). Returns the
  // padded axis max plus every tick value from 0 up to it.
  function niceTicks(dmax, count = 4) {
    if (!(dmax > 0)) return { max: 1, ticks: [0, 1] };
    const rough = dmax / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const max = Math.ceil(dmax / step) * step;
    const ticks = [];
    for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(+v.toFixed(6));
    return { max, ticks };
  }

  // Y-axis ticks for count axes (line, vertical bars): whole-number steps of
  // 1 / 2 / 5 x 10^n, the smallest one that needs at most `maxIntervals` steps
  // to cover the data, so 306 reads 0 50 100 ... 350 instead of 0 77 153 230 306.
  function niceCountTicks(dmax, maxIntervals = 7) {
    if (!(dmax > 0)) return { max: 1, ticks: [0, 1] };
    let step = 1;
    for (let mag = 1; ; mag *= 10) {
      const hit = [1, 2, 5].map(m => m * mag).find(st => Math.ceil(dmax / st) <= maxIntervals);
      if (hit) { step = hit; break; }
    }
    const max = Math.ceil(dmax / step) * step;
    const ticks = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    return { max, ticks };
  }

  // The scatter's y axis always draws 5 gridlines (and the zoom re-labels them
  // by position), so give it a window of exactly 4 equal round steps that covers
  // the data with a little margin: win rates 21-49 -> 20 30 40 50 60. `cap`
  // (e.g. 100 for a percentage) keeps the window from running past it.
  function niceWindow4(y0, y1, cap = null) {
    const m = Math.max((y1 - y0) * 0.03, 0.5);
    for (let mag = 1; ; mag *= 10) {
      for (const st of [1, 2, 5].map(k => k * mag)) {
        let lo = Math.floor((y0 - m) / st) * st;
        if (lo < 0) lo = 0;
        if (cap != null && lo + 4 * st > cap) lo = Math.max(0, Math.floor((cap - 4 * st) / st) * st);
        if (lo <= y0 - m && lo + 4 * st >= y1 + m) return { lo, hi: lo + 4 * st };
        if (lo === 0 && lo + 4 * st >= y1 + m) return { lo, hi: lo + 4 * st };   // 0 is as low as it goes
      }
    }
  }

  // Horizontal bars: data = [{ label, value, color?, meta? }]. The x-axis uses
  // nice tick values (axisFmt labels them); a bar's exact value lives in the tap
  // caption (meta), not at the bar end.
  function barsH(data, { axisFmt = v => v, labelW = 96, color = 'var(--accent)' } = {}) {
    if (!data.length) return empty();
    const dmax = Math.max(...data.map(d => d.value)) || 1;
    const { max, ticks } = niceTicks(dmax, 4);
    const top = 10, B = 24, RM = 12;   // RM: right margin so the last tick label is not clipped
    const rowH = Math.min(36, (H - top - B) / data.length), bw = W - labelW - RM;
    const botY = top + data.length * rowH;   // baseline = bottom of the last bar
    // x-axis: a gridline + label at each nice tick, drawn behind the bars.
    let axis = '';
    for (const v of ticks) {
      const x = labelW + (v / max) * bw;
      const anchor = v === 0 ? 'start' : v === max ? 'end' : 'middle';
      axis += `<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${botY.toFixed(1)}" class="ch-grid"/><text x="${x.toFixed(1)}" y="${(botY + 13).toFixed(1)}" class="ch-ax" text-anchor="${anchor}">${_esc(axisFmt(v))}</text>`;
    }
    const rows = data.map((d, i) => {
      const y = top + i * rowH, len = Math.max(2, (d.value / max) * bw);
      const name = d.name != null ? d.name : d.label;
      const meta = d.meta != null ? d.meta : String(d.value);
      return `
        <text x="${labelW - 8}" y="${y + rowH / 2}" class="ch-lbl" text-anchor="end" dominant-baseline="middle">${_esc(d.label)}</text>
        <rect${hit(name, meta, d.href)} x="${labelW}" y="${y + 5}" width="${len.toFixed(1)}" height="${rowH - 14}" rx="3" fill="${d.color || color}"><title>${titleText(name, meta)}</title></rect>`;
    }).join('');
    return wrap(axis + rows);
  }

  // Vertical bars: data = [{ value, ... }]. xTick(i) optional axis label every xEvery.
  function barsV(data, { fmt = v => v, color = 'var(--accent)', xTick = null, xEvery = 1 } = {}) {
    if (!data.length) return empty();
    const L = 32, R = 10, T = 14, B = 26;
    const { max, ticks } = niceCountTicks(Math.max(...data.map(d => d.value)) || 1);
    const bw = (W - L - R) / data.length;
    const sy = v => (H - B) - v / max * (H - T - B);
    let grid = '';
    for (const v of ticks) {
      const yy = sy(v);
      grid += `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}" class="ch-grid"/><text x="${L - 5}" y="${yy.toFixed(1)}" class="ch-ax" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }
    const bars = data.map((d, i) => {
      const x = L + i * bw, yv = sy(d.value), h = (H - B) - yv;
      const tick = (xTick && i % xEvery === 0) ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" class="ch-ax" text-anchor="middle">${_esc(xTick(i))}</text>` : '';
      const name = d.name != null ? d.name : (xTick ? String(xTick(i)) : '');
      const meta = d.meta != null ? d.meta : String(fmt(d.value, d));
      return `<rect${hit(name, meta)} x="${(x + 1.5).toFixed(1)}" y="${yv.toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${color}"><title>${titleText(name, meta)}</title></rect>${tick}`;
    }).join('');
    return wrap(grid + bars);
  }

  // Scatter: points = [{ x, y, label, color? }]. xSuffix/ySuffix label the axis
  // ticks (e.g. '%'); the zoom code re-labels those same ticks as you zoom.
  function scatter(points, { xLabel = '', xSuffix = '', ySuffix = '', yMax = null } = {}) {
    if (!points.length) return empty();
    const L = 42, R = 14, T = 14, B = 40, PW = W - L - R, PH = H - T - B;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    // Fit the axes to the data range (with a little padding) rather than forcing
    // a zero origin, so the cloud fills the plot instead of hugging a corner.
    // Clamp the low end at 0 (games/percent are non-negative) and the high end at
    // yMax when given (e.g. 100 for a percentage axis).
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const xpad = (x1 - x0) * 0.08 || 1;
    const xlo = Math.max(0, x0 - xpad), xhi = x1 + xpad;
    const { lo: ylo, hi: yhi } = niceWindow4(y0, y1, yMax);   // round gridline values, not 21 28 35 ...
    const sx = x => L + (x - xlo) / (xhi - xlo) * PW;
    const sy = y => (H - B) - (y - ylo) / (yhi - ylo) * PH;
    let grid = '';
    // y gridlines stay put; their labels (ch-ytick) are rewritten by the zoom.
    for (let i = 0; i <= 4; i++) {
      const v = ylo + (yhi - ylo) * i / 4, yy = sy(v);
      grid += `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}" class="ch-grid"/><text x="${L - 6}" y="${yy.toFixed(1)}" class="ch-ax ch-ytick" text-anchor="end" dominant-baseline="middle">${_esc(Math.round(v) + ySuffix)}</text>`;
    }
    // x gridlines + ticks (ch-xtick), likewise re-labeled on zoom.
    for (let i = 0; i <= 4; i++) {
      const v = xlo + (xhi - xlo) * i / 4, xx = sx(v);
      const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
      grid += `<line x1="${xx.toFixed(1)}" y1="${T}" x2="${xx.toFixed(1)}" y2="${(H - B).toFixed(1)}" class="ch-grid"/><text x="${xx.toFixed(1)}" y="${H - B + 14}" class="ch-ax ch-xtick" text-anchor="${anchor}">${_esc(Math.round(v) + xSuffix)}</text>`;
    }
    // Dots carry the name + meta (+ optional href) so the page can show a
    // clickable caption on tap (the <title> hover tooltip does not fire on touch).
    // A transparent, wide stroke pads the tappable area well past the visible
    // fill (the SVG "painted" hit-test area includes the stroke even though
    // its color is invisible) without changing how the dot looks; .ch-dot's
    // non-scaling-stroke keeps that padding a constant screen size at every
    // zoom level, same as the dot radius itself.
    const dots = points.map(p => {
      const boxAttr = p.box ? ` data-box="${_esc(p.box)}" data-boxhref="${_esc(p.boxHref || '')}"` : '';
      return `<circle${hit(p.label, p.meta, p.href, 'ch-dot')}${boxAttr} cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="8" fill="${p.color || 'var(--accent)'}" fill-opacity="0.85" stroke="transparent" stroke-width="16"><title>${titleText(p.label, p.meta)}</title></circle>`;
    }).join('');
    // The dots ride in a group that the zoom transforms, wrapped in a fixed clip
    // (the plot rect) so the zoom never spills over the axes. The plot ranges and
    // tick suffixes ride on the group so the zoom code can re-place dots and
    // re-label the (fixed-position) ticks for the visible window.
    const plot =
      `<clipPath id="scClip"><rect x="${L}" y="${T}" width="${PW}" height="${PH}"/></clipPath>` +
      `<g clip-path="url(#scClip)"><g class="ch-pan"` +
      ` data-l="${L}" data-r="${R}" data-t="${T}" data-b="${B}"` +
      ` data-xlo="${xlo}" data-xhi="${xhi}" data-ylo="${ylo}" data-yhi="${yhi}"` +
      ` data-xsuf="${_esc(xSuffix)}" data-ysuf="${_esc(ySuffix)}">${dots}</g></g>`;
    const frame = `<rect class="ch-plot-frame" x="${L}" y="${T}" width="${PW}" height="${PH}" fill="none"/>`;
    const badge =
      `<g class="ch-zoom-badge" transform="translate(${W - R - 4} ${T + 4})">` +
      `<rect class="ch-zoom-badge-bg" x="-44" y="0" width="44" height="17" rx="4"/>` +
      `<text class="ch-zoom-badge-txt" x="-22" y="12" text-anchor="middle">1×</text></g>`;
    const axis = xLabel ? `<text x="${((L + W - R) / 2).toFixed(1)}" y="${H - 6}" class="ch-axlbl" text-anchor="middle">${_esc(xLabel)}</text>` : '';
    return wrap(grid + plot + frame + badge + axis, { cls: 'ch-zoomable' });
  }

  // Histogram from raw values; bins evenly across [min, max], then drawn as barsV.
  function histogram(values, { bins = 12, color = 'var(--accent)' } = {}) {
    values = values.filter(v => v != null && !isNaN(v));
    if (!values.length) return empty();
    const min = Math.min(...values), max = Math.max(...values);
    const step = ((max - min) || 1) / bins;
    const counts = new Array(bins).fill(0);
    for (const v of values) { let b = Math.floor((v - min) / step); if (b >= bins) b = bins - 1; if (b < 0) b = 0; counts[b]++; }
    const data = counts.map((c, i) => ({ value: c, lo: Math.round(min + i * step), hi: Math.round(min + (i + 1) * step) }));
    return barsV(data, {
      color,
      fmt: (v, d) => `${d.lo}-${d.hi}: ${v}`,
      xTick: i => Math.round(min + i * step),
      xEvery: Math.max(1, Math.ceil(bins / 6)),
    });
  }

  // Line + soft area over ordered points = [{ label, value }].
  // `visible`: when set and there are more points than that, only `visible`
  // points are shown at a time and the rest sit off to the left, reachable by
  // panning (charts.js _attachLinePan). It starts on the most recent points.
  // The y scale stays fixed to the global max so the axis doesn't jump while
  // panning; gridlines + y labels stay put and only the data pans.
  function line(points, { fmt = v => v, color = 'var(--accent)', visible = null } = {}) {
    if (!points.length) return empty();
    const L = 34, R = 12, T = 14, B = 28, PW = W - L - R;
    const { max, ticks: yTicks } = niceCountTicks(Math.max(...points.map(p => p.value)) || 1);
    const n = points.length;
    const pannable = !!visible && n > visible;
    const PAD = 10;                                  // pannable: room at both ends so the edge labels (wider on phones) fit
    const slot = (PW - 2 * PAD) / (visible || n);    // pannable: width of one point's slot
    // Pannable points sit in content space (center of their slot), the pan group
    // is translated into place; otherwise they're spread edge to edge as before.
    const sx = pannable
      ? i => PAD + (i + 0.5) * slot
      : i => L + (n === 1 ? PW / 2 : i / (n - 1) * PW);
    const sy = v => (H - B) - v / max * (H - T - B);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)} ${sy(p.value).toFixed(1)}`).join(' ');
    const area = `${path} L${sx(n - 1).toFixed(1)} ${H - B} L${sx(0).toFixed(1)} ${H - B} Z`;
    let grid = '';
    for (const v of yTicks) {
      const yy = sy(v);
      grid += `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}" class="ch-grid"/><text x="${L - 5}" y="${yy.toFixed(1)}" class="ch-ax" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }
    // x ticks. Static view: cap the count by available width (~80px per label) so
    // wide labels like YYYY/MM never crowd, picked evenly and including both
    // endpoints (first/last edge-anchored so they stay inside the viewBox).
    // Pannable view: every other month counting back from the latest, so labels
    // keep their place on the data while it pans (and the newest is always one).
    let idxs;
    if (pannable) {
      idxs = new Set(points.map((_, i) => i).filter(i => (n - 1 - i) % 2 === 0));
    } else {
      const maxLabels = Math.max(2, Math.min(n, Math.floor(PW / 80) + 1));
      idxs = new Set();
      for (let j = 0; j < maxLabels; j++) idxs.add(Math.round(j * (n - 1) / (maxLabels - 1)));
    }
    let ticks = '';
    points.forEach((p, i) => {
      if (!idxs.has(i)) return;
      const anchor = pannable ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      ticks += `<text x="${sx(i).toFixed(1)}" y="${H - 8}" class="ch-ax" text-anchor="${anchor}">${_esc(p.label)}</text>`;
    });
    // Same invisible-stroke tap padding as the scatter's dots (see there for why).
    const dots = points.map((p, i) => {
      const meta = p.meta != null ? p.meta : String(fmt(p.value));
      return `<circle${hit(p.label, meta, p.href)} cx="${sx(i).toFixed(1)}" cy="${sy(p.value).toFixed(1)}" r="4" fill="${color}" stroke="transparent" stroke-width="16"><title>${titleText(p.label, meta)}</title></circle>`;
    }).join('');
    const data = `<path d="${area}" fill="${color}" fill-opacity="0.12"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
    if (!pannable) return wrap(`${data}${grid}${ticks}${dots}`);

    // The pan groups start translated so the last `visible` points are in view;
    // the clip keeps the older ones from spilling over the y axis. The label row
    // gets a clip inset a little from the axis, so the label of the month just
    // off-screen doesn't poke a stray fragment into the plot while at rest.
    const maxOff = (n - visible) * slot;
    const tf = `translate(${(L - maxOff).toFixed(2)} 0)`;
    const LBL_INSET = 20;
    return wrap(
      `${grid}<clipPath id="lnClip"><rect x="${L}" y="0" width="${PW}" height="${H}"/></clipPath>` +
      `<clipPath id="lnLblClip"><rect x="${L + LBL_INSET}" y="0" width="${PW - LBL_INSET}" height="${H}"/></clipPath>` +
      `<g clip-path="url(#lnClip)"><g class="ch-lpan" data-l="${L}" data-w="${W}" data-maxoff="${maxOff.toFixed(2)}"` +
      ` transform="${tf}">${data}${dots}</g></g>` +
      `<g clip-path="url(#lnLblClip)"><g class="ch-lpan" transform="${tf}">${ticks}</g></g>`,
      { cls: 'ch-pannable' });
  }

  // Donut: segments = [{ label, value, color? }] + side legend.
  function donut(segments) {
    segments = segments.filter(s => s.value > 0);
    if (!segments.length) return empty();
    const total = segments.reduce((a, s) => a + s.value, 0);
    const r = 114, rin = 68, cy = H / 2;
    // Center the donut + legend as one block (the legend width is estimated from
    // the longest label) rather than pinning the donut to the left.
    const maxLabel = Math.max(...segments.map(s => String(s.label).length));
    const legendW = 19 + maxLabel * 6.5, gap = 26;   // swatch + gap + ~text width
    const startX = Math.max(0, (W - (2 * r + gap + legendW)) / 2);
    const cx = startX + r;
    const lx = startX + 2 * r + gap;
    const p = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    let a0 = -Math.PI / 2, arcs = '';
    segments.forEach((s, i) => {
      const frac = s.value / total, a1 = a0 + frac * 2 * Math.PI, big = (a1 - a0) > Math.PI ? 1 : 0;
      const col = s.color || PALETTE[i % PALETTE.length];
      const meta = s.meta != null ? s.meta : `${s.value} (${Math.round(frac * 100)}%)`;
      // A stroke in the card color gives every slice a uniform separator.
      arcs += `<path${hit(s.label, meta, s.href)} d="M${p(r, a0)} A${r} ${r} 0 ${big} 1 ${p(r, a1)} L${p(rin, a1)} A${rin} ${rin} 0 ${big} 0 ${p(rin, a0)} Z" fill="${col}" stroke="var(--s1)" stroke-width="2"><title>${titleText(s.label, meta)}</title></path>`;
      a0 = a1;
    });
    const ly = cy - segments.length * 12;
    const legend = segments.map((s, i) => {
      const col = s.color || PALETTE[i % PALETTE.length], y = ly + i * 26;
      return `<rect x="${lx}" y="${y}" width="13" height="13" rx="2" fill="${col}"/><text x="${lx + 19}" y="${y + 11}" class="ch-lbl">${_esc(s.label)}</text>`;
    }).join('');
    return wrap(arcs + legend);
  }

  // Heatmap: rowLabels[], colLabels[], cell(ri, ci) -> { value: 0..1 | null, label, title }.
  function heatmap(rowLabels, colLabels, cell) {
    if (!rowLabels.length || !colLabels.length) return empty();
    const L = 46, T = 22, R = 12, B = 8;
    const cw = (W - L - R) / colLabels.length, chh = (H - T - B) / rowLabels.length;
    let out = '';
    colLabels.forEach((c, ci) => { out += `<text x="${(L + ci * cw + cw / 2).toFixed(1)}" y="${T - 7}" class="ch-ax" text-anchor="middle">${_esc(c)}</text>`; });
    rowLabels.forEach((rl, ri) => {
      out += `<text x="${L - 6}" y="${(T + ri * chh + chh / 2).toFixed(1)}" class="ch-ax" text-anchor="end" dominant-baseline="middle">${_esc(rl)}</text>`;
      colLabels.forEach((c, ci) => {
        const d = cell(ri, ci), x = L + ci * cw, y = T + ri * chh;
        if (!d || d.value == null) {
          out += `<rect x="${(x + 1).toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(chh - 2).toFixed(1)}" rx="3" class="ch-cell-empty"/>`;
        } else {
          const meta = d.meta != null ? d.meta : (d.title || '');
          out += `<rect${hit(d.name, meta, d.href)} x="${(x + 1).toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(chh - 2).toFixed(1)}" rx="3" fill="${heatColor(d.value)}"><title>${titleText(d.name, meta)}</title></rect>` +
                 `<text x="${(x + cw / 2).toFixed(1)}" y="${(y + chh / 2).toFixed(1)}" class="ch-cellval" text-anchor="middle" dominant-baseline="middle">${_esc(d.label || '')}</text>`;
        }
      });
    });
    return wrap(out);
  }
  // value 0..1 -> ramp from a dim blue (cool/low) to the accent purple (hot/high).
  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const lo = [38, 56, 110], hi = [124, 106, 247];
    const c = lo.map((l, i) => Math.round(l + (hi[i] - l) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  return { barsH, barsV, scatter, histogram, line, donut, heatmap, PALETTE };
})();
