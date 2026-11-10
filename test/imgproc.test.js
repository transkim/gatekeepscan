const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/js/imgproc.js');

// Draw a scene: background colour with noise, a paper quad with "text" lines.
function scene(w, h, quad, bg, paper, seed = 1) {
  const img = P.makeImage(w, h);
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c === 0) continue;
      const s = c > 0 ? 1 : -1;
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  };
  // map to paper coords for text lines
  const H = P.homography(quad, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let c = bg.map((v) => v + (rnd() - 0.5) * 30);
    if (inside(x, y)) {
      const u = P.applyH(H, x, y);
      const line = u.y > 0.1 && u.y < 0.9 && u.x > 0.1 && u.x < 0.85 && (u.y * 20) % 1 < 0.35 && (u.x * 37) % 1 < 0.7;
      c = line ? [30, 30, 40] : paper.map((v) => v - u.x * 25 + (rnd() - 0.5) * 6); // uneven light
    }
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  return img;
}

function maxCornerError(found, quad, w, h) {
  return Math.max(...found.map((p, i) => Math.hypot(p.x * w - quad[i].x, p.y * h - quad[i].y)));
}

test('detects a tilted page on a dark desk', () => {
  const w = 360, h = 480;
  const quad = [{ x: 70, y: 60 }, { x: 300, y: 85 }, { x: 320, y: 420 }, { x: 40, y: 400 }];
  const img = scene(w, h, quad, [90, 60, 40], [235, 232, 225]);
  const r = P.detectQuad(img);
  assert.ok(r, 'should find a page');
  assert.ok(maxCornerError(r.quad, quad, w, h) < 8, 'corners within 8px: ' + JSON.stringify(r.quad));
});

test('detects a white page on a light grey table', () => {
  const w = 360, h = 480;
  const quad = [{ x: 50, y: 80 }, { x: 290, y: 50 }, { x: 330, y: 430 }, { x: 60, y: 450 }];
  const img = scene(w, h, quad, [175, 175, 170], [245, 245, 242], 7);
  const r = P.detectQuad(img);
  assert.ok(r, 'should find a page');
  assert.ok(maxCornerError(r.quad, quad, w, h) < 10, 'corners within 10px: ' + JSON.stringify(r.quad));
});

test('returns null for a featureless image', () => {
  const img = P.makeImage(200, 200);
  img.data.fill(128);
  assert.strictEqual(P.detectQuad(img), null);
});

test('orderQuad orders corners clockwise from top-left', () => {
  const q = P.orderQuad([{ x: 10, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 10 }, { x: 90, y: 90 }]);
  assert.deepStrictEqual(q, [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]);
});

test('homography maps corners exactly', () => {
  const a = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  const b = [{ x: 10, y: 5 }, { x: 80, y: 20 }, { x: 95, y: 70 }, { x: 3, y: 60 }];
  const H = P.homography(a, b);
  a.forEach((p, i) => {
    const q = P.applyH(H, p.x, p.y);
    assert.ok(Math.abs(q.x - b[i].x) < 1e-6 && Math.abs(q.y - b[i].y) < 1e-6);
  });
});

test('warp straightens the page and filters whiten the paper', () => {
  const w = 360, h = 480;
  const quad = [{ x: 70, y: 60 }, { x: 300, y: 85 }, { x: 320, y: 420 }, { x: 40, y: 400 }];
  const img = scene(w, h, quad, [90, 60, 40], [215, 210, 200]);
  const size = P.outputSize(quad, 1000);
  const flat = P.warp(img, quad, size.width, size.height);
  assert.strictEqual(flat.width, size.width);
  // corner pixel is paper, not desk
  const c = flat.data.slice(((5 * flat.width) + 5) * 4, ((5 * flat.width) + 5) * 4 + 3);
  assert.ok(c[0] > 180, 'paper at corner: ' + c);
  for (const f of ['clean', 'bw']) {
    const out = P.applyFilter(flat, f);
    const p = ((Math.round(flat.height * 0.05) * flat.width) + Math.round(flat.width * 0.5)) * 4;
    assert.ok(out.data[p] >= 245, f + ' paper should be white, got ' + out.data[p]);
  }
});

test('rotate swaps dimensions and moves pixels', () => {
  const img = P.makeImage(3, 2);
  img.data.set([255, 0, 0, 255], 0); // top-left red
  const r = P.rotate(img, 90);
  assert.strictEqual(r.width, 2); assert.strictEqual(r.height, 3);
  assert.strictEqual(r.data[(0 * 2 + 1) * 4], 255); // now top-right
});

test('keeps a dark header band that reaches the page edge', () => {
  const w = 240, h = 320;
  const quad = [{ x: 40, y: 40 }, { x: 200, y: 48 }, { x: 206, y: 280 }, { x: 30, y: 270 }];
  const img = scene(w, h, quad, [185, 185, 180], [245, 245, 242], 3);
  // paint the top fifth of the page dark blue (in page coordinates)
  const H = P.homography(quad, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = P.applyH(H, x, y);
    if (u.x > 0 && u.x < 1 && u.y > 0 && u.y < 0.2) { const o = (y * w + x) * 4; img.data[o] = 25; img.data[o + 1] = 40; img.data[o + 2] = 90; }
  }
  const r = P.detectQuad(img);
  assert.ok(r, 'should find a page');
  assert.ok(maxCornerError(r.quad, quad, w, h) < 8, 'whole page incl. the band: ' + JSON.stringify(r.quad.map((p) => [Math.round(p.x * w), Math.round(p.y * h)])));
});

test('does not stop at ruled lines inside the page', () => {
  const w = 240, h = 320;
  const quad = [{ x: 30, y: 30 }, { x: 205, y: 36 }, { x: 212, y: 290 }, { x: 24, y: 284 }];
  const img = scene(w, h, quad, [70, 60, 50], [250, 250, 248], 5);
  const H = P.homography(quad, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = P.applyH(H, x, y);
    if (u.x > 0.08 && u.x < 0.92 && u.y > 0.08 && u.y < 0.92 && (Math.abs((u.y * 10) % 1) < 0.04 || Math.abs((u.x * 4) % 1) < 0.02)) {
      const o = (y * w + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
    }
  }
  const r = P.detectQuad(img);
  assert.ok(r, 'should find a page');
  assert.ok(maxCornerError(r.quad, quad, w, h) < 8, 'outer page, not the table: ' + JSON.stringify(r.quad.map((p) => [Math.round(p.x * w), Math.round(p.y * h)])));
});

test('the crop never trims into the page', () => {
  const w = 240, h = 320;
  const quad = [{ x: 46, y: 40 }, { x: 200, y: 56 }, { x: 213, y: 280 }, { x: 26, y: 266 }];
  const r = P.detectQuad(scene(w, h, quad, [90, 60, 40], [235, 232, 225]));
  assert.ok(r);
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  r.quad.forEach((p, i) => {
    const found = Math.hypot(p.x * w - cx, p.y * h - cy), real = Math.hypot(quad[i].x - cx, quad[i].y - cy);
    assert.ok(found > real - 1.5, 'corner ' + i + ' is inside the page by ' + (real - found).toFixed(1) + 'px');
  });
});
