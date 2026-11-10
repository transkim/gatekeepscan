/* Browser side of the scan pipeline: decoding images, the processing worker, rendering pages to JPEG. */
(function (root) {
  'use strict';
  const IP = root.ImgProc;
  const SRC_MAX = 3200;   // longest side kept for originals
  const OUT_MAX = 2480;   // longest side of a finished page (~300 dpi on A4 width-ish)
  const THUMB_MAX = 420;

  // ---- worker with main-thread fallback ----
  let worker = null, seq = 0;
  const pending = new Map();
  try {
    worker = new Worker('js/proc-worker.js');
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    worker.onerror = () => { worker = null; pending.forEach((p) => p.reject(new Error('worker failed'))); pending.clear(); };
  } catch (_) { worker = null; }

  function runLocal(op, args) {
    if (op === 'detect') return IP.detectQuad(args.image);
    if (op === 'filter') return IP.applyFilter(args.image, args.filter, args);
    if (op === 'render') {
      let img = args.image;
      if (args.quad) {
        const q = args.quad.map((p) => ({ x: p.x * img.width, y: p.y * img.height }));
        const s = IP.outputSize(q, args.maxSide);
        img = IP.warp(img, q, s.width, s.height);
      }
      if (args.rotation) img = IP.rotate(img, args.rotation);
      return IP.applyFilter(img, args.filter, args);
    }
    throw new Error('unknown op');
  }

  function call(op, args) {
    if (!worker) return Promise.resolve().then(() => runLocal(op, args));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    }).catch(() => runLocal(op, args));
  }

  // ---- image helpers ----
  async function decode(blob) {
    if (root.createImageBitmap) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (_) { /* fall back */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read this image.'));
      img.src = URL.createObjectURL(blob);
    });
  }

  function dims(src) {
    return { w: src.naturalWidth || src.videoWidth || src.width, h: src.naturalHeight || src.videoHeight || src.height };
  }

  function toCanvas(src, maxSide) {
    const { w, h } = dims(src);
    const k = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function imageData(src, maxSide) {
    const c = toCanvas(src, maxSide);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: d.data };
  }

  function dataToCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
    return c;
  }

  const toBlob = (canvas, type = 'image/jpeg', q = 0.88) =>
    new Promise((resolve) => canvas.toBlob(resolve, type, q));

  // Store a capture at a sensible size so the library does not balloon.
  async function normalize(blobOrCanvas) {
    const src = blobOrCanvas instanceof Blob ? await decode(blobOrCanvas) : blobOrCanvas;
    const c = toCanvas(src, SRC_MAX);
    const blob = await toBlob(c, 'image/jpeg', 0.9);
    return { blob, width: c.width, height: c.height, canvas: c };
  }

  // Page detection works on a small copy (256px), drawn into one reused canvas so the live camera
  // loop does not allocate a new one for every frame.
  let detCanvas = null;
  async function detect(src) {
    const { w, h } = dims(src);
    if (!w || !h) return null;
    const k = 256 / Math.max(w, h);
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    if (!detCanvas) detCanvas = document.createElement('canvas');
    if (detCanvas.width !== cw || detCanvas.height !== ch) { detCanvas.width = cw; detCanvas.height = ch; }
    const g = detCanvas.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'medium';
    g.drawImage(src, 0, 0, cw, ch);
    const d = g.getImageData(0, 0, cw, ch);
    const r = await call('detect', { image: { width: cw, height: ch, data: d.data } });
    return r ? r.quad : null;
  }

  // ---- page rendering ----
  const srcCache = new Map(); // pageId -> ImageData-like of the original (kept for the page being edited)

  async function sourceFor(page) {
    if (srcCache.has(page.id)) return srcCache.get(page.id);
    const bmp = await decode(page.src);
    const d = imageData(bmp, SRC_MAX);
    if (bmp.close) bmp.close();
    if (srcCache.size > 3) srcCache.delete(srcCache.keys().next().value);
    srcCache.set(page.id, d);
    return d;
  }

  function drawMarks(canvas, page) {
    if (!page.marks || !page.marks.length) return Promise.resolve();
    const g = canvas.getContext('2d');
    return Promise.all(page.marks.map((m) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        g.drawImage(img, m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height);
        resolve();
      };
      img.onerror = resolve;
      img.src = m.png;
    })));
  }

  // Produce the finished page (JPEG) and thumbnail from the original + settings.
  async function render(page, opts) {
    opts = opts || {};
    const src = await sourceFor(page);
    const copy = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    const out = await call('render', {
      image: copy, quad: page.quad, maxSide: opts.maxSide || OUT_MAX, rotation: page.rotation || 0,
      filter: page.filter || 'original', brightness: page.brightness || 0, contrast: page.contrast || 0,
    });
    const canvas = dataToCanvas(out);
    await drawMarks(canvas, page);
    if (opts.preview) return { canvas };
    const blob = await toBlob(canvas, 'image/jpeg', 0.88);
    const thumb = await toBlob(toCanvas(canvas, THUMB_MAX), 'image/jpeg', 0.8);
    return { blob, thumb, width: canvas.width, height: canvas.height, canvas };
  }

  // Small previews of each filter for the filter strip.
  async function filterPreviews(page, size) {
    const src = await sourceFor(page);
    const copy = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    const base = await call('render', { image: copy, quad: page.quad, maxSide: size * 2, rotation: page.rotation || 0, filter: 'original' });
    const out = {};
    for (const f of IP.FILTERS) {
      const img = await call('filter', { image: { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) }, filter: f.id });
      out[f.id] = dataToCanvas(img).toDataURL('image/jpeg', 0.7);
    }
    return out;
  }

  // Put two cropped card sides on one portrait page (ID card mode).
  async function composeCards(canvases) {
    const W = 1654, H = 2339; // A4 at 200 dpi
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const slotH = H * 0.42, slotW = W * 0.8;
    canvases.slice(0, 2).forEach((cv, i) => {
      const k = Math.min(slotW / cv.width, slotH / cv.height);
      const w = cv.width * k, h = cv.height * k;
      g.drawImage(cv, (W - w) / 2, H * (i === 0 ? 0.06 : 0.52) + (slotH - h) / 2, w, h);
    });
    return c;
  }

  async function cropToCanvas(blob, quad) {
    const bmp = await decode(blob);
    const d = imageData(bmp, SRC_MAX);
    const out = await call('render', { image: d, quad, maxSide: 1600, rotation: 0, filter: 'original' });
    return dataToCanvas(out);
  }

  root.Scan = {
    call, decode, toCanvas, imageData, dataToCanvas, toBlob, normalize, detect, render, filterPreviews,
    composeCards, cropToCanvas, forget: (id) => srcCache.delete(id), dims, OUT_MAX,
  };
})(typeof self !== 'undefined' ? self : this);
