// Scores page detection on a set made by gen.py.
// usage: node run.js <path to imgproc.js> <size, 256> <set dir> [verbose]
// CUT = part of the page fell outside the crop; LOOSE = the crop takes in clearly more than the page.
const fs = require('fs'), path = require('path');
const P = require(path.resolve(process.argv[2]));
const size = Number(process.argv[3] || 360), DIR = path.resolve(process.argv[4] || 'scenes'), verbose = process.argv[5];
const S = JSON.parse(fs.readFileSync(DIR + '/index.json'));
// signed distance of point outside quad (positive = outside)
function outside(q, p) {
  let m = -1e9;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = ((b.y - a.y) * (p.x - a.x) - (b.x - a.x) * (p.y - a.y)) / len; // >0 = outside for clockwise TL,TR,BR,BL in screen coords
    m = Math.max(m, d);
  }
  return m;
}
let miss = 0, cut = 0, loose = 0, good = 0, t = 0; const out = [];
for (const s of S) {
  const rgb = fs.readFileSync(DIR + '/' + s.name + '.rgb');
  const img = P.makeImage(s.w, s.h);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { img.data[j] = rgb[i]; img.data[j + 1] = rgb[i + 1]; img.data[j + 2] = rgb[i + 2]; img.data[j + 3] = 255; }
  const small = P.downscale(img, size);
  P.detectQuad(small);
  const t0 = process.hrtime.bigint();
  let r; for (let k = 0; k < 3; k++) r = P.detectQuad(small);
  t += Number(process.hrtime.bigint() - t0) / 3e6;
  const asp = s.w / s.h;
  const px = (p) => ({ x: p.x * asp, y: p.y });           // units of frame height
  // truth clipped to frame for off-frame scenes
  const clip = (p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });
  const truthRaw = s.quad.map(([x, y]) => px({ x, y }));
  const truth = truthRaw;
  if (!r) { miss++; out.push(s.name + ' MISS'); continue; }
  const q = r.quad.map(px);
  const cutBy = Math.max(...s.quad.map(([x, y]) => outside(q, px(clip({ x, y })))));      // how far the true page sticks out of the crop
  const looseBy = Math.max(...q.map((p) => outside(truth, p)));    // how far the crop sticks out of the page
  const tag = cutBy > 0.012 ? 'CUT' : looseBy > 0.03 ? 'LOOSE' : 'ok';
  if (tag === 'CUT') cut++; else if (tag === 'LOOSE') loose++; else good++;
  if (tag !== 'ok' || verbose) out.push(`${s.name} ${tag} cut=${(cutBy * 100).toFixed(1)}% loose=${(looseBy * 100).toFixed(1)}%`);
}
console.log(out.join('\n'));
console.log(`size ${size}: good ${good}/${S.length}, cut ${cut}, loose ${loose}, miss ${miss}, avg ${(t / S.length).toFixed(1)} ms`);
