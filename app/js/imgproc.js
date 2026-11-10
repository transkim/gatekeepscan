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

  /* Fallback detector: looks for a bright paper-like blob. Used when no clear straight edges are found. */
  function detectByMask(img) {
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

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score < 0.15) return null;
    const quad = best.quad.map((p) => ({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) }));
    return { quad, score: best.score };
  }

  // ---------- page detection by straight edges ----------
  // Finds long straight edges (Hough transform), builds four-sided shapes from them and keeps the
  // best supported one. When several shapes are about equally good it takes the biggest, so the
  // crop never stops at a line inside the page (a table rule, a header band, a column of text).
  const COS = new Float32Array(180), SIN = new Float32Array(180);
  for (let t = 0; t < 180; t++) { COS[t] = Math.cos(t * Math.PI / 180); SIN[t] = Math.sin(t * Math.PI / 180); }

  function intersect(a, b) {
    const det = a.c * b.s - a.s * b.c;
    if (Math.abs(det) < 1e-6) return null;
    return { x: (a.rho * b.s - b.rho * a.s) / det, y: (b.rho * a.c - a.rho * b.c) / det };
  }

  function detectByLines(img, dbg) {
    const w = img.width, h = img.height, n = w * h, data = img.data;
    const minDim = Math.min(w, h);
    if (minDim < 40) return null;

    // smoothed colour channels, brightness and saturation
    let R = new Float32Array(n), Gn = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) { R[i] = data[p]; Gn[i] = data[p + 1]; B[i] = data[p + 2]; }
    R = boxBlur(R, w, h, 1); Gn = boxBlur(Gn, w, h, 1); B = boxBlur(B, w, h, 1);
    const L = new Float32Array(n), S = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = R[i], g = Gn[i], b = B[i];
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      S[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }

    // colour gradient: the channel with the strongest edge wins
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    const hist = new Uint32Array(256);
    const chans = [R, Gn, B];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let bx = 0, by = 0, bm = -1;
        for (let k = 0; k < 3; k++) {
          const C = chans[k];
          const a = C[i - w - 1], b = C[i - w], c = C[i - w + 1], d = C[i - 1], e = C[i + 1], f = C[i + w - 1], g = C[i + w], q = C[i + w + 1];
          const sx = c + 2 * e + q - a - 2 * d - f, sy = f + 2 * g + q - a - 2 * b - c;
          const m = sx * sx + sy * sy;
          if (m > bm) { bm = m; bx = sx; by = sy; }
        }
        gx[i] = bx; gy[i] = by;
        const m = Math.sqrt(bm);
        mag[i] = m;
        hist[m > 255 ? 255 : m | 0]++;
      }
    }
    let acc = 0, thr = 0;
    const want = (w - 2) * (h - 2) * 0.8;
    for (; thr < 256 && acc < want; thr++) acc += hist[thr];
    thr = Math.min(22, Math.max(12, thr));

    // thin edges (non-maximum suppression) with their direction in whole degrees
    const edge = new Uint8Array(n), eth = new Uint8Array(n), pol = new Uint8Array(n);
    const edgeList = [];
    const off = Math.max(2, Math.round(minDim / 85)), off2 = 2 * off + 2;
    const diag = Math.ceil(Math.hypot(w, h)) + 2, RW = 2 * diag + 1;
    const hough = new Uint16Array(180 * RW);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, m = mag[i];
        if (m < thr) continue;
        const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
        let o;
        if (ax > 2.414 * ay) o = 1;
        else if (ay > 2.414 * ax) o = w;
        else o = (gx[i] > 0) === (gy[i] > 0) ? w + 1 : w - 1;
        if (m < mag[i - o] || m <= mag[i + o]) continue;
        let t = Math.round(Math.atan2(gy[i], gx[i]) * 180 / Math.PI);
        t = ((t % 180) + 180) % 180;
        // is this a boundary between two different surfaces (page | desk), or just a thin stroke
        // (text, a ruled line) with the same paper on both sides?
        const ux = gx[i] / m, uy = gy[i] / m;
        // Compared at two distances, so a stroke a few pixels thick does not pass for a boundary.
        let kind = 1, pl = 3;
        const x1 = Math.round(x + off * ux), y1 = Math.round(y + off * uy), x0 = Math.round(x - off * ux), y0 = Math.round(y - off * uy);
        if (x1 >= 0 && y1 >= 0 && x1 < w && y1 < h && x0 >= 0 && y0 >= 0 && x0 < w && y0 < h) {
          const j1 = y1 * w + x1, j0 = y0 * w + x0;
          const dL = L[j1] - L[j0], dS = S[j1] - S[j0];
          if (Math.abs(dL) + 0.6 * Math.abs(dS) >= 7) {
            kind = 2; pl = dL >= 3 ? 1 : dL <= -3 ? 2 : 3;
            const X1 = Math.round(x + off2 * ux), Y1 = Math.round(y + off2 * uy), X0 = Math.round(x - off2 * ux), Y0 = Math.round(y - off2 * uy);
            if (X1 >= 0 && Y1 >= 0 && X1 < w && Y1 < h && X0 >= 0 && Y0 >= 0 && X0 < w && Y0 < h) {
              const J1 = Y1 * w + X1, J0 = Y0 * w + X0;
              const eL = L[J1] - L[J0], eS = S[J1] - S[J0];
              if (Math.abs(eL) + 0.6 * Math.abs(eS) < 6 || (Math.abs(dL) >= 6 && Math.abs(eL) >= 6 && (dL > 0) !== (eL > 0))) kind = 3;  // thin: half credit
            }
          }
        }
        edge[i] = kind; eth[i] = t; pol[i] = pl;
        edgeList.push(i);
        const wt = kind === 2 ? 3 : kind === 3 ? 2 : 1;
        for (let d = -3; d <= 3; d++) {
          const tt = (t + d + 180) % 180;
          hough[tt * RW + Math.round(x * COS[tt] + y * SIN[tt]) + diag] += wt;
        }
      }
    }

    // strongest lines
    const minVotes = Math.max(30, minDim * 0.36);          // a boundary pixel casts 3 votes
    const peaks = [];
    for (let t = 0; t < 180; t++) {
      const row = t * RW;
      for (let r = 1; r < RW - 1; r++) {
        const v = hough[row + r];
        if (v < minVotes * 0.5) continue;
        const sum = v + hough[row + r - 1] + hough[row + r + 1];
        if (sum < minVotes || v < hough[row + r - 1] || v < hough[row + r + 1]) continue;
        peaks.push({ t, r: r - diag, v: sum });
      }
    }
    peaks.sort((a, b) => b.v - a.v);
    const near = (l, t, r, dT, dR) => {
      let dt = Math.abs(t - l.t), r2 = r;
      if (dt > 90) { dt = 180 - dt; r2 = -r2; }
      return dt <= dT && Math.abs(r2 - l.rho) <= dR;
    };
    const rough = [];
    for (const p of peaks) {
      if (rough.some((l) => near(l, p.t, p.r, 5, 5))) continue;
      rough.push({ t: p.t, rho: p.r, c: COS[p.t], s: SIN[p.t], votes: p.v });
      if (rough.length >= 60) break;
    }
    // fit each line exactly through the edge pixels that voted for it
    const nE = edgeList.length, ex = new Int16Array(nE), ey = new Int16Array(nE);
    for (let k = 0; k < nE; k++) { const i = edgeList[k]; ex[k] = i % w; ey[k] = (i / w) | 0; }
    const fitted = [];
    for (const l of rough) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, cnt = 0;
      for (let k = 0; k < nE; k++) {
        const x = ex[k], y = ey[k];
        const dd = x * l.c + y * l.s - l.rho;
        if (dd > 2.5 || dd < -2.5) continue;
        const i = edgeList[k];
        let dt = Math.abs(eth[i] - l.t); if (dt > 90) dt = 180 - dt;
        if (dt > 14) continue;
        const wt = edge[i] === 1 ? 1 : 3;
        sx += wt * x; sy += wt * y; sxx += wt * x * x; syy += wt * y * y; sxy += wt * x * y; cnt += wt;
      }
      let c = l.c, sn = l.s, rho = l.rho, t = l.t;
      if (cnt >= 24) {
        const mx = sx / cnt, my = sy / cnt;
        const a = sxx / cnt - mx * mx, b = sxy / cnt - mx * my, d = syy / cnt - my * my;
        const ang = 0.5 * Math.atan2(2 * b, a - d);             // direction of the line
        let nc = -Math.sin(ang), ns = Math.cos(ang);
        if (ns < 0 || (ns === 0 && nc < 0)) { nc = -nc; ns = -ns; }
        let nt = Math.atan2(ns, nc) * 180 / Math.PI; if (nt >= 180) nt -= 180;
        let dt = Math.abs(nt - t); if (dt > 90) dt = 180 - dt;
        if (dt <= 6) { c = nc; sn = ns; rho = mx * nc + my * ns; t = nt; }
      }
      if (fitted.some((o) => near(o, t, rho, 2.5, 2.5))) continue;
      fitted.push({ t, c, s: sn, rho, votes: l.votes, virtual: false });
    }
    if (fitted.length < 2) return null;

    // Score with firm boundaries only. If that finds nothing convincing (white paper on a white
    // desk, where only a thin shadow line marks the edge) try again giving thin lines part credit.
    const solve = (thin) => {
      const lines = fitted.map((l) => Object.assign({}, l));
      // how well is every stretch of a line backed by a real boundary? An edge pixel must be there AND
      // the two sides must differ (a thin ruled line or text baseline has the same paper on both sides).
      for (const l of lines) {
        const pos = new Float32Array(RW + 1), neg = new Float32Array(RW + 1), any = new Float32Array(RW + 1), sw = new Float32Array(RW + 1);
        for (let k = 0; k < RW; k++) {
          const tt = k - diag;
          const x = l.rho * l.c - tt * l.s, y = l.rho * l.s + tt * l.c;
          let a = 0, b = 0;
          if (x >= 1 && y >= 1 && x < w - 1 && y < h - 1) {
            for (let o = -1; o <= 1; o++) {
              const ex = Math.round(x + o * 1.3 * l.c), ey = Math.round(y + o * 1.3 * l.s);
              if (ex < 1 || ey < 1 || ex >= w - 1 || ey >= h - 1) continue;
              const j = ey * w + ex;
              if (edge[j] < 2 || (edge[j] === 3 && !thin)) continue;
              let dt = Math.abs(eth[j] - l.t); if (dt > 14 && dt < 166) continue;
              const along = gx[j] * l.c + gy[j] * l.s > 0;          // gradient points to the +normal side
              const cr = edge[j] === 2 ? 1 : thin;                  // a thin shadow line counts for less
              if (pol[j] === 3) a = b = cr;
              else if ((pol[j] === 1) === along) a = cr; else b = cr;
              break;
            }
          }
          const flipped = (x >= 1 && y >= 1 && x < w - 1 && y < h - 1) ? 1 : 0;   // inside the picture
          pos[k + 1] = pos[k] + a; neg[k + 1] = neg[k] + b; any[k + 1] = any[k] + Math.max(a, b); sw[k + 1] = sw[k] + flipped;
        }
        l.pos = pos; l.neg = neg; l.any = any; l.sw = sw;
      }
      // Keep the lines worth building a page from. Lines with no real boundary under them (text rows,
      // ruled lines, tile joints) go. Per direction keep the best supported few plus the outermost ones,
      // so the true page edge is always in the running even on a striped cloth or a page full of boxes.
      {
        const real = lines.filter((l) => l.any[RW] >= minDim * 0.12).sort((p, q) => q.any[RW] - p.any[RW]);
        const clusters = [];
        for (const l of real) {
          let cl = null;
          for (const k of clusters) { let dt = Math.abs(k.head.t - l.t); if (dt > 90) dt = 180 - dt; if (dt <= 10) { cl = k; break; } }
          if (!cl) { cl = { head: l, items: [] }; clusters.push(cl); }
          l.ar = (l.c * cl.head.c + l.s * cl.head.s) < 0 ? -l.rho : l.rho;
          cl.items.push(l);
        }
        lines.length = 0;
        for (const cl of clusters.slice(0, 4)) {
          const keep = new Set(cl.items.slice(0, 5));
          const byRho = cl.items.slice().sort((p, q) => p.ar - q.ar);
          for (let k = 0; k < 2 && k < byRho.length; k++) { keep.add(byRho[k]); keep.add(byRho[byRho.length - 1 - k]); }
          for (const l of keep) lines.push(l);
        }
        if (lines.length < 2) return null;
      }
      // the frame itself can stand in for a side when the page runs off the picture
      const V = 0.5;
      lines.push({ t: 0, c: 1, s: 0, rho: -0.5, virtual: true }, { t: 0, c: 1, s: 0, rho: w - 0.5, virtual: true },
        { t: 90, c: 0, s: 1, rho: -0.5, virtual: true }, { t: 90, c: 0, s: 1, rho: h - 0.5, virtual: true });

      const N = lines.length;
      const angle = (a, b) => { const d = Math.abs(a.t - b.t); return d > 90 ? 180 - d : d; };
      const pairs = [];
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (angle(lines[i], lines[j]) <= 35) pairs.push([i, j]);

      const tOf = (l, p) => -p.x * l.s + p.y * l.c + diag;
      const sideInfo = (l, p, q) => {
        let lo = tOf(l, p), hi = tOf(l, q);
        const flip = lo > hi;                                   // walking against the line's own direction
        if (flip) { const tmp = lo; lo = hi; hi = tmp; }
        const len = hi - lo;
        if (l.virtual) return { len, s: V, ends: V, e0: V, e1: V, bright: 0.5, cont: 0 };
        const a = Math.max(0, Math.round(lo)), b = Math.min(RW, Math.round(hi));
        const e = Math.max(2, Math.round(len * 0.12));
        const P = l.pos[b] - l.pos[a], Q = l.neg[b] - l.neg[a];
        // only the part of the side that is inside the picture can be checked
        const vis = l.sw[b] - l.sw[a];
        const s = (l.any[b] - l.any[a]) / Math.max(vis, 0.5 * len, 1);
        const win = (u, v) => { const iw = l.sw[v] - l.sw[u]; return iw < e / 2 ? V : (l.any[v] - l.any[u]) / iw; };
        const wa = win(a, Math.min(RW, a + e)), wb = win(Math.max(0, b - e), b);
        const ends = (wa + wb) / 2;
        // "pos" = brighter on the +normal side. Walking clockwise on screen the inside is on the right of
        // travel, and the line's own direction (-s, c) has the +normal on its left.
        const insideBright = flip ? P : Q;
        // does the edge carry on past the corners? Then this side is only part of something longer.
        const cont = ((l.any[a] - l.any[Math.max(0, a - e)]) + (l.any[Math.min(RW, b + e)] - l.any[b])) / (2 * e);
        return { len, s: Math.min(1, s), ends: Math.min(1, ends), e0: flip ? wb : wa, e1: flip ? wa : wb, bright: (P + Q) ? insideBright / (P + Q) : 0.5, cont: Math.min(1, cont) };
      };

      const m = minDim * 0.25, minArea = n * 0.05, minSide = minDim * 0.12;
      const cands = [];
      for (let pi = 0; pi < pairs.length; pi++) {
        const a = lines[pairs[pi][0]], b = lines[pairs[pi][1]];
        for (let pj = pi + 1; pj < pairs.length; pj++) {
          const c = lines[pairs[pj][0]], d = lines[pairs[pj][1]];
          if (a === c || a === d || b === c || b === d) continue;
          const nv = a.virtual + b.virtual + c.virtual + d.virtual;
          if (nv > 2) continue;
          if (angle(a, c) < 50 || angle(a, d) < 50 || angle(b, c) < 50 || angle(b, d) < 50) continue;
          const p1 = intersect(a, c), p2 = intersect(c, b), p3 = intersect(b, d), p4 = intersect(d, a);
          if (!p1 || !p2 || !p3 || !p4) continue;
          let pts = [p1, p2, p3, p4], sl = [c, b, d, a];          // side k runs pts[k] -> pts[k+1] on line sl[k]
          let ok = true;
          for (const p of pts) if (p.x < -m || p.y < -m || p.x > w - 1 + m || p.y > h - 1 + m) { ok = false; break; }
          if (!ok) continue;
          // convex, and make it clockwise on screen
          let sign = 0;
          for (let k = 0; k < 4 && ok; k++) {
            const p = pts[k], q = pts[(k + 1) % 4], r = pts[(k + 2) % 4];
            const cr = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
            if (Math.abs(cr) < 1e-6) ok = false;
            else if (!sign) sign = cr > 0 ? 1 : -1;
            else if ((cr > 0 ? 1 : -1) !== sign) ok = false;
          }
          if (!ok) continue;
          if (sign < 0) { pts = [p1, p4, p3, p2]; sl = [a, d, b, c]; }
          const area = polyArea(pts);
          if (area < minArea) continue;
          const ang = quadAngles(pts);
          if (ang[0] < 45 || ang[0] > 135 || ang[1] < 45 || ang[1] > 135 || ang[2] < 45 || ang[2] > 135 || ang[3] < 45 || ang[3] > 135) continue;
          let per = 0, sum = 0, mn = 1, ends = 0, bright = 0, cont = 0, short = false;
          const lens = [], infos = [];
          for (let k = 0; k < 4; k++) {
            const info = sideInfo(sl[k], pts[k], pts[(k + 1) % 4]);
            if (info.len < minSide) { short = true; break; }
            infos.push(info); lens.push(info.len);
            per += info.len; sum += info.s * info.len; ends += info.ends; bright += info.bright * info.len; cont += info.cont;
            if (info.s < mn) mn = info.s;
          }
          // the frame may only stand in for a side when the page really runs off the picture there:
          // the neighbouring sides must be visible right up to the border
          for (let k = 0; k < 4 && !short; k++) {
            if (!sl[k].virtual) continue;
            const pv = (k + 3) % 4, nx = (k + 1) % 4;
            if ((!sl[pv].virtual && infos[pv].e1 < 0.55) || (!sl[nx].virtual && infos[nx].e0 < 0.55)) short = true;
          }
          if (short) continue;
          if (Math.min(lens[0], lens[2]) < 0.4 * Math.max(lens[0], lens[2]) || Math.min(lens[1], lens[3]) < 0.4 * Math.max(lens[1], lens[3])) continue;
          const quality = (sum / per) * Math.sqrt(mn) * (0.6 + 0.4 * ends / 4) * (1 - 0.6 * cont / 4);
          cands.push({ pts, sl, area, quality, nv, bright: bright / per, ss: infos.map((i) => i.s.toFixed(2) + "/" + i.ends.toFixed(2)) });
        }
      }
      if (dbg) { dbg.lines = lines; dbg.cands = cands; dbg.thr = thr; dbg.edge = edge; }
      if (!cands.length) return null;
      let bestQ = 0;
      for (const c of cands) if (c.quality > bestQ) bestQ = c.quality;
      if (bestQ < 0.27) return null;
      let best = null, bestRank = 0;
      for (const c of cands) {
        if (c.quality < bestQ * 0.72) continue;
        const rel = c.quality / bestQ;
        const rank = c.area * (0.5 + 0.5 * rel) * (1 - 0.15 * c.nv);   // real edges beat the frame border
        if (rank > bestRank) { bestRank = rank; best = c; }
      }

      // Grow: while the two neighbouring sides visibly carry on past a corner and there is another
      // edge further out, the page is bigger than this. Stops the crop at a header band or picture edge.
      {
        const pts = best.pts.slice(), sl = best.sl.slice();
        for (let iter = 0; iter < 6; iter++) {
          let changed = false;
          const cx0 = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4, cy0 = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
          for (let k = 0; k < 4; k++) {
            const l = sl[k], prev = sl[(k + 3) % 4], next = sl[(k + 1) % 4];
            const oP = pts[k], oQ = pts[(k + 1) % 4];
            const oldD = Math.abs(cx0 * l.c + cy0 * l.s - l.rho);
            let pick = null, pickD = oldD + 2.5;
            for (const cand of lines) {
              if (cand === l || cand === prev || cand === next || cand === sl[(k + 2) % 4]) continue;
              if (angle(cand, l) > 20) continue;
              const nP = intersect(prev, cand), nQ = intersect(cand, next);
              if (!nP || !nQ) continue;
              if (nP.x < -m || nP.y < -m || nP.x > w - 1 + m || nP.y > h - 1 + m || nQ.x < -m || nQ.y < -m || nQ.x > w - 1 + m || nQ.y > h - 1 + m) continue;
              // must lie beyond the current side, on the far side from the centre
              const sideOld = (cx0 * l.c + cy0 * l.s - l.rho) > 0 ? 1 : -1;
              if (((nP.x * l.c + nP.y * l.s - l.rho) > 0 ? 1 : -1) === sideOld || ((nQ.x * l.c + nQ.y * l.s - l.rho) > 0 ? 1 : -1) === sideOld) continue;
              const d = Math.min(Math.hypot(nP.x - oP.x, nP.y - oP.y), Math.hypot(nQ.x - oQ.x, nQ.y - oQ.y));
              if (d < 2.5 || oldD + d <= pickD) continue;
              if (!cand.virtual && sideInfo(cand, nP, nQ).s < 0.35) continue;
              if (cand.virtual) { if ((!prev.virtual && sideInfo(prev, nP, oP).e0 < 0.55) || (!next.virtual && sideInfo(next, oQ, nQ).e1 < 0.55)) continue; }
              if (!prev.virtual && sideInfo(prev, nP, oP).s < 0.4) continue;
              if (!next.virtual && sideInfo(next, oQ, nQ).s < 0.4) continue;
              pick = { cand, nP, nQ }; pickD = oldD + d;
            }
            if (pick) { sl[k] = pick.cand; pts[k] = pick.nP; pts[(k + 1) % 4] = pick.nQ; changed = true; }
          }
          if (!changed) break;
        }
        best = { pts, sl, quality: best.quality };
      }

      // slide every side onto the strongest nearby edge, then give the page a hair of extra room
      const cx = (best.pts[0].x + best.pts[1].x + best.pts[2].x + best.pts[3].x) / 4;
      const cy = (best.pts[0].y + best.pts[1].y + best.pts[2].y + best.pts[3].y) / 4;
      const margin = minDim * 0.003;
      const refined = [];
      for (let k = 0; k < 4; k++) {
        const l = best.sl[k], p = best.pts[k], q = best.pts[(k + 1) % 4];
        if (l.virtual) { refined.push(l); continue; }
        const len = Math.hypot(q.x - p.x, q.y - p.y), steps = Math.max(8, Math.round(len * 0.8));
        let bo = 0, bq = 0, bs = -1;
        for (let oa = -2; oa <= 2; oa += 0.5) {
          for (let ob = -2; ob <= 2; ob += 0.5) {
            let sc = 0;
            for (let i = 0; i <= steps; i++) {
              const f = 0.1 + 0.8 * i / steps, o = oa + (ob - oa) * f;
              const x = Math.round(p.x + (q.x - p.x) * f + o * l.c), y = Math.round(p.y + (q.y - p.y) * f + o * l.s);
              if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
              const j = y * w + x;
              sc += Math.abs(gx[j] * l.c + gy[j] * l.s);
            }
            sc -= (Math.abs(oa) + Math.abs(ob)) * 0.002 * sc;
            if (sc > bs) { bs = sc; bo = oa; bq = ob; }
          }
        }
        const P = { x: p.x + bo * l.c, y: p.y + bo * l.s }, Q = { x: q.x + bq * l.c, y: q.y + bq * l.s };
        let nx = -(Q.y - P.y), ny = Q.x - P.x;
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        let rho = P.x * nx + P.y * ny;
        const side = cx * nx + cy * ny - rho;                       // centre is on this side of the line
        rho += side > 0 ? -margin : margin;
        refined.push({ c: nx, s: ny, rho });
      }
      const quad = [];
      for (let k = 0; k < 4; k++) {
        const p = intersect(refined[(k + 3) % 4], refined[k]) || best.pts[k];
        // a corner may sit a little outside the picture when the page runs off the frame
        quad.push({ x: Math.min(1.15, Math.max(-0.15, (p.x + 0.5) / w)), y: Math.min(1.15, Math.max(-0.15, (p.y + 0.5) / h)) });
      }
      return { quad: orderQuad(quad), score: best.quality };
    };
    const first = solve(0);
    if (first && first.score >= 0.42) return first;
    const second = solve(0.55);
    if (second && (!first || second.score > first.score)) return second;
    return first;
  }

  /* Find the document in a small image (about 250px for live preview, about 500px for a still).
   * Returns { quad: [TL,TR,BR,BL] in 0..1 image fractions, score } or null. */
  function detectQuad(img) {
    if (Math.max(img.width, img.height) > 260) img = downscale(img, 256);   // tuned for this size, and fast
    return detectByLines(img) || detectByMask(img);
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
    detectQuad, detectByLines, detectByMask, homography, applyH, outputSize, warp, rotate, applyFilter, background, downscale, FILTERS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ImgProc = api;
})(typeof self !== 'undefined' ? self : this);
