/* Pagekeep image processing: page edge detection, perspective correction and scan filters.
 * Pure functions on ImageData-like objects { data: Uint8ClampedArray (RGBA), width, height },
 * so they run the same in the app and in Node tests. */
(function (root) {
  'use strict';

  function makeImage(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  // ---------- helpers ----------
  function luminance(img) {
    const { data, width, height } = img;
    const L = new Float32Array(width * height);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
      L[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return L;
  }

  // separable box blur, radius r, returns new array
  function boxBlur(src, w, h, r) {
    if (r < 1) return Float32Array.from(src);
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function sobel(L, w, h) {
    const G = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
        const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
        G[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return G;
  }

  function otsu(values, lo, hi) {
    const bins = 256, hist = new Float64Array(bins);
    const span = hi - lo || 1;
    for (let i = 0; i < values.length; i++) {
      let b = Math.floor(((values[i] - lo) / span) * (bins - 1));
      hist[b < 0 ? 0 : b >= bins ? bins - 1 : b]++;
    }
    let total = values.length, sum = 0;
    for (let i = 0; i < bins; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 0;
    for (let i = 0; i < bins; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return lo + ((thr + 0.5) / (bins - 1)) * span;
  }

  function dilate(mask, w, h, r) {
    // square structuring element via two 1-D passes
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = mask[y * w + k];
        tmp[y * w + x] = v;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function erode(mask, w, h, r) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
    const d = dilate(inv, w, h, r);
    for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
    return d;
  }

  // largest 4-connected component of mask; returns { mask, area } or null
  function largestComponent(mask, w, h) {
    const labels = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    let bestLabel = 0, bestArea = 0, label = 0;
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || labels[s]) continue;
      label++;
      let head = 0, tail = 0, area = 0;
      queue[tail++] = s; labels[s] = label;
      while (head < tail) {
        const i = queue[head++]; area++;
        const x = i % w;
        if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = label; queue[tail++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = label; queue[tail++] = i + 1; }
        if (i >= w && mask[i - w] && !labels[i - w]) { labels[i - w] = label; queue[tail++] = i - w; }
        if (i < w * (h - 1) && mask[i + w] && !labels[i + w]) { labels[i + w] = label; queue[tail++] = i + w; }
      }
      if (area > bestArea) { bestArea = area; bestLabel = label; }
    }
    if (!bestLabel) return null;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
    return { mask: out, area: bestArea };
  }

  function boundaryPoints(mask, w, h) {
    const pts = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) pts.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
    return pts;
  }

  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  // Order 4 points as top-left, top-right, bottom-right, bottom-left (clockwise on screen).
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let start = 0;
    for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
    return [0, 1, 2, 3].map((k) => ({ x: sorted[(start + k) % 4].x, y: sorted[(start + k) % 4].y }));
  }

  // Largest-area quadrilateral with corners on the hull (local search from extreme points).
  function quadFromHull(hull) {
    if (hull.length < 4) return null;
    let idx = [0, 0, 0, 0];
    hull.forEach((p, i) => {
      if (p.x + p.y < hull[idx[0]].x + hull[idx[0]].y) idx[0] = i;
      if (p.x - p.y > hull[idx[1]].x - hull[idx[1]].y) idx[1] = i;
      if (p.x + p.y > hull[idx[2]].x + hull[idx[2]].y) idx[2] = i;
      if (p.x - p.y < hull[idx[3]].x - hull[idx[3]].y) idx[3] = i;
    });
    const area = (ids) => polyArea(ids.map((i) => hull[i]));
    for (let iter = 0; iter < 4; iter++) {
      let changed = false;
      for (let c = 0; c < 4; c++) {
        let best = idx[c], bestA = area(idx);
        for (let i = 0; i < hull.length; i++) {
          if (idx.includes(i)) continue;
          const trial = idx.slice(); trial[c] = i;
          const a = area(trial);
          if (a > bestA + 1e-6) { bestA = a; best = i; }
        }
        if (best !== idx[c]) { idx[c] = best; changed = true; }
      }
      if (!changed) break;
    }
    if (new Set(idx).size < 4) return null;
    return orderQuad(idx.map((i) => hull[i]));
  }

  function quadAngles(q) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const a = Math.atan2(p.y - c.y, p.x - c.x), b = Math.atan2(n.y - c.y, n.x - c.x);
      let d = Math.abs(a - b) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      out.push(d);
    }
    return out;
  }

  // mean gradient sampled along the quad's edges, slightly outside/inside to tolerate 1-2px error
  function edgeSupport(G, w, h, q) {
    let sum = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(8, Math.round(len));
      const nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        let best = 0;
        for (let o = -2; o <= 2; o++) {
          const x = Math.round(a.x + (b.x - a.x) * t + nx * o);
          const y = Math.round(a.y + (b.y - a.y) * t + ny * o);
          if (x > 0 && y > 0 && x < w - 1 && y < h - 1) best = Math.max(best, G[y * w + x]);
        }
        sum += best; n++;
      }
    }
    return n ? sum / n : 0;
  }

  function evaluate(compMask, area, G, gMean, w, h) {
    const total = w * h;
    if (area < total * 0.06) return null;
    const hull = convexHull(boundaryPoints(compMask, w, h));
    const q = quadFromHull(hull);
    if (!q) return null;
    const qa = polyArea(q);
    if (qa < total * 0.06) return null;
    const angles = quadAngles(q);
    if (angles.some((a) => a < 40 || a > 140)) return null;
    const fit = Math.min(1, polyArea(hull) / qa) * Math.min(1, area / qa); // 1 for a clean rectangle-ish blob
    if (fit < 0.75) return null;
    const support = edgeSupport(G, w, h, q) / (gMean * 4 + 1e-6);
    const touches = q.filter((p) => p.x < 2 || p.y < 2 || p.x > w - 2 || p.y > h - 2).length;
    const score = Math.min(2.5, support) * Math.pow(fit, 3) * Math.sqrt(qa / total) * (1 - 0.12 * touches);
    return { quad: q, score, fit, support };
  }

  /* Find the document in a (small, ~300-400px) image.
   * Returns { quad: [TL,TR,BR,BL] in 0..1 image fractions, score } or null. */
  function detectQuad(img) {
    const { width: w, height: h, data } = img;
    const L0 = luminance(img);
    const L = boxBlur(L0, w, h, 1);
    const G = sobel(L, w, h);
    let gMean = 0;
    for (let i = 0; i < G.length; i++) gMean += G[i];
    gMean /= G.length;

    const candidates = [];
    const tryMask = (mask) => {
      const closed = erode(dilate(mask, w, h, 2), w, h, 2);
      const opened = dilate(erode(closed, w, h, 1), w, h, 1);
      const comp = largestComponent(opened, w, h);
      if (!comp) return;
      const r = evaluate(comp.mask, comp.area, G, gMean, w, h);
      if (r) candidates.push(r);
    };

    // 1) bright, low-colour "paper" pixels
    const P = new Float32Array(w * h);
    for (let i = 0, p = 0; i < P.length; i++, p += 4) {
      const mx = Math.max(data[p], data[p + 1], data[p + 2]), mn = Math.min(data[p], data[p + 1], data[p + 2]);
      P[i] = L[i] - 0.8 * (mx - mn);
    }
    const tP = otsu(P, -255, 255);
    const m1 = new Uint8Array(w * h);
    for (let i = 0; i < m1.length; i++) m1[i] = P[i] > tP ? 1 : 0;
    tryMask(m1);

    // 2) plain brightness
    const tL = otsu(L, 0, 255);
    const m2 = new Uint8Array(w * h);
    for (let i = 0; i < m2.length; i++) m2[i] = L[i] > tL ? 1 : 0;
    tryMask(m2);

    // 3) region enclosed by strong edges (works for white paper on light tables)
    let gMax = 0;
    for (let i = 0; i < G.length; i++) if (G[i] > gMax) gMax = G[i];
    for (const frac of [0.5, 0.3]) {
      const tG = Math.max(otsu(G, 0, gMax || 1) * frac * 2, gMean * 1.5);
      const edges = new Uint8Array(w * h);
      for (let i = 0; i < edges.length; i++) edges[i] = G[i] > tG ? 1 : 0;
      const wall = dilate(edges, w, h, 1);
      const outside = new Uint8Array(w * h);
      const queue = new Int32Array(w * h);
      let head = 0, tail = 0;
      const seed = (i) => { if (!wall[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (head < tail) {
        const i = queue[head++], x = i % w;
        if (x > 0) seed(i - 1);
        if (x < w - 1) seed(i + 1);
        if (i >= w) seed(i - w);
        if (i < w * (h - 1)) seed(i + w);
      }
      const inside = new Uint8Array(w * h);
      for (let i = 0; i < inside.length; i++) inside[i] = outside[i] ? 0 : 1; // include the edge wall itself
      tryMask(inside);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score < 0.15) return null;
    // pull the corners in a little so no desk shows along the page edges
    const cx = best.quad.reduce((s, p) => s + p.x, 0) / 4, cy = best.quad.reduce((s, p) => s + p.y, 0) / 4;
    const quad = best.quad.map((p) => {
      const d = Math.hypot(p.x - cx, p.y - cy) || 1, k = 2.4 / d;
      return { x: Math.min(1, Math.max(0, (p.x - (p.x - cx) * k) / w)), y: Math.min(1, Math.max(0, (p.y - (p.y - cy) * k) / h)) };
    });
    return { quad, score: best.score };
  }

  // ---------- perspective ----------
  function solve(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      const d = A[c][c];
      if (Math.abs(d) < 1e-12) throw new Error('singular');
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / d;
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    return b.map((v, i) => v / A[i][i]);
  }

  // homography H mapping from[i] -> to[i]; returns 9 numbers (h33 = 1)
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i], u = to[i].x, v = to[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return solve(A, b).concat(1);
  }

  function applyH(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // natural output size for a quad (pixel coords), capped to maxSide
  function outputSize(q, maxSide) {
    let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const s = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  }

  // Straighten quad q (pixel coords in src) into an outW x outH image.
  function warp(src, q, outW, outH) {
    const dst = makeImage(outW, outH);
    const H = homography(
      [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], q);
    const sw = src.width, sh = src.height, s = src.data, d = dst.data;
    for (let y = 0; y < outH; y++) {
      const yy = y + 0.5;
      for (let x = 0; x < outW; x++) {
        const xx = x + 0.5;
        const den = H[6] * xx + H[7] * yy + H[8];
        let fx = (H[0] * xx + H[1] * yy + H[2]) / den - 0.5;
        let fy = (H[3] * xx + H[4] * yy + H[5]) / den - 0.5;
        if (fx < 0) fx = 0; else if (fx > sw - 1) fx = sw - 1;
        if (fy < 0) fy = 0; else if (fy > sh - 1) fy = sh - 1;
        const x0 = fx | 0, y0 = fy | 0;
        const x1 = x0 < sw - 1 ? x0 + 1 : x0, y1 = y0 < sh - 1 ? y0 + 1 : y0;
        const ax = fx - x0, ay = fy - y0;
        const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        const o = (y * outW + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = s[p00 + c] + (s[p10 + c] - s[p00 + c]) * ax;
          const bot = s[p01 + c] + (s[p11 + c] - s[p01 + c]) * ax;
          d[o + c] = top + (bot - top) * ay;
        }
        d[o + 3] = 255;
      }
    }
    return dst;
  }

  function rotate(img, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return img;
    const { width: w, height: h, data: s } = img;
    const out = deg === 180 ? makeImage(w, h) : makeImage(h, w);
    const d = out.data, ow = out.width;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let nx, ny;
        if (deg === 90) { nx = h - 1 - y; ny = x; }
        else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
        else { nx = y; ny = w - 1 - x; }
        const si = (y * w + x) * 4, di = (ny * ow + nx) * 4;
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255;
      }
    }
    return out;
  }

  // ---------- filters ----------
  // Estimate the paper (background) brightness at every pixel: block maxima, smoothed.
  function background(L, w, h) {
    const bs = Math.max(4, Math.round(Math.max(w, h) / 120));
    const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
    const grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        // 90th percentile-ish: max of a sparse sample of the block, then averaged with mean of top
        let mx = 0;
        const y1 = Math.min(h, (gy + 1) * bs), x1 = Math.min(w, (gx + 1) * bs);
        for (let y = gy * bs; y < y1; y += 2) for (let x = gx * bs; x < x1; x += 2) {
          const v = L[y * w + x]; if (v > mx) mx = v;
        }
        grid[gy * gw + gx] = mx;
      }
    }
    // max filter then blur on the grid, so big dark areas take the paper level of their neighbourhood
    let g = grid;
    const mx = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(gw - 1, Math.max(0, x + dx)), yy = Math.min(gh - 1, Math.max(0, y + dy));
        m = Math.max(m, g[yy * gw + xx]);
      }
      mx[y * gw + x] = m;
    }
    g = boxBlur(boxBlur(mx, gw, gh, 2), gw, gh, 2);
    let gmax = 0;
    for (let i = 0; i < g.length; i++) gmax = Math.max(gmax, g[i]);
    const floor = Math.max(60, gmax * 0.45);
    const bg = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / bs - 0.5));
      const y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / bs - 0.5));
        const x0 = fx | 0, x1 = Math.min(gw - 1, x0 + 1), ax = fx - x0;
        const top = g[y0 * gw + x0] + (g[y0 * gw + x1] - g[y0 * gw + x0]) * ax;
        const bot = g[y1 * gw + x0] + (g[y1 * gw + x1] - g[y1 * gw + x0]) * ax;
        bg[y * w + x] = Math.max(floor, top + (bot - top) * ay);
      }
    }
    return bg;
  }

  function percentile(L, lowP, highP) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < L.length; i++) hist[L[i] < 0 ? 0 : L[i] > 255 ? 255 : L[i] | 0]++;
    let acc = 0, lo = 0, hi = 255;
    const nLo = L.length * lowP, nHi = L.length * highP;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc <= nLo) lo = i; if (acc < nHi) hi = i + 1; }
    return { lo, hi: Math.max(hi, lo + 16) };
  }

  const FILTERS = [
    { id: 'original', name: 'Original' },
    { id: 'auto', name: 'Auto' },
    { id: 'vivid', name: 'Vivid' },
    { id: 'clean', name: 'Clean' },
    { id: 'gray', name: 'Grey' },
    { id: 'bw', name: 'B & W' },
    { id: 'ink', name: 'Ink saver' },
  ];

  /* Apply a scan filter. opts: { brightness: -100..100, contrast: -100..100 } */
  function applyFilter(img, filter, opts) {
    opts = opts || {};
    const { width: w, height: h, data: s } = img;
    const out = makeImage(w, h), d = out.data;
    const L = luminance(img);
    const n = w * h;
    const sat = (o, r, g, b, k) => {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[o] = l + (r - l) * k; d[o + 1] = l + (g - l) * k; d[o + 2] = l + (b - l) * k;
    };
    if (filter === 'auto') {
      const { lo, hi } = percentile(L, 0.01, 0.985);
      const k = 255 / (hi - lo);
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        sat(o, (s[o] - lo) * k, (s[o + 1] - lo) * k, (s[o + 2] - lo) * k, 1.12);
        d[o + 3] = 255;
      }
    } else if (filter === 'vivid' || filter === 'clean' || filter === 'gray' || filter === 'bw' || filter === 'ink') {
      const bg = background(L, w, h);
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const k = 255 / bg[i];
        if (filter === 'vivid' || filter === 'clean') {
          let r = s[o] * k, g = s[o + 1] * k, b = s[o + 2] * k;
          // push near-white paper to pure white, deepen ink
          const curve = (v) => {
            v = (v - 28) * 1.18;
            return v > 238 ? 255 : v;
          };
          r = curve(r); g = curve(g); b = curve(b);
          sat(o, r, g, b, filter === 'vivid' ? 1.45 : 1.0);
          if (filter === 'clean') {
            const l = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
            if (l > 215) { d[o] = d[o + 1] = d[o + 2] = 255; }
          }
        } else {
          const r = L[i] * k / 255; // 1 = paper, 0 = black
          let v;
          if (filter === 'gray') {
            v = r > 0.9 ? 255 : Math.pow(Math.max(0, (r - 0.08) / 0.82), 1.35) * 255;
          } else if (filter === 'bw') {
            v = r < 0.70 ? 0 : r > 0.84 ? 255 : ((r - 0.70) / 0.14) * 255;
          } else { // ink saver: grey text, white paper
            v = r < 0.72 ? 90 : r > 0.86 ? 255 : 90 + ((r - 0.72) / 0.14) * 165;
          }
          d[o] = d[o + 1] = d[o + 2] = v;
        }
        d[o + 3] = 255;
      }
    } else {
      d.set(s);
    }
    const br = (opts.brightness || 0) * 1.2, ct = opts.contrast || 0;
    if (br || ct) {
      const f = (259 * (ct + 255)) / (255 * (259 - ct));
      for (let o = 0; o < d.length; o += 4) {
        d[o] = f * (d[o] - 128) + 128 + br;
        d[o + 1] = f * (d[o + 1] - 128) + 128 + br;
        d[o + 2] = f * (d[o + 2] - 128) + 128 + br;
      }
    }
    return out;
  }

  // simple area-average downscale (for tests and for detection input)
  function downscale(img, maxSide) {
    const { width: w, height: h, data: s } = img;
    const k = Math.max(w, h) / maxSide;
    if (k <= 1) return img;
    const ow = Math.max(1, Math.round(w / k)), oh = Math.max(1, Math.round(h / k));
    const out = makeImage(ow, oh), d = out.data;
    for (let y = 0; y < oh; y++) {
      const ys = Math.floor(y * h / oh), ye = Math.max(ys + 1, Math.floor((y + 1) * h / oh));
      for (let x = 0; x < ow; x++) {
        const xs = Math.floor(x * w / ow), xe = Math.max(xs + 1, Math.floor((x + 1) * w / ow));
        let r = 0, g = 0, b = 0, c = 0;
        for (let yy = ys; yy < ye; yy++) for (let xx = xs; xx < xe; xx++) {
          const p = (yy * w + xx) * 4; r += s[p]; g += s[p + 1]; b += s[p + 2]; c++;
        }
        const o = (y * ow + x) * 4;
        d[o] = r / c; d[o + 1] = g / c; d[o + 2] = b / c; d[o + 3] = 255;
      }
    }
    return out;
  }

  const api = {
    makeImage, luminance, boxBlur, otsu, convexHull, polyArea, orderQuad, quadFromHull, quadAngles,
    detectQuad, homography, applyH, outputSize, warp, rotate, applyFilter, background, downscale, FILTERS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ImgProc = api;
})(typeof self !== 'undefined' ? self : this);
