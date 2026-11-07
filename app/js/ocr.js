/* Offline text recognition (Tesseract, English model bundled with the app). */
(function (root) {
  'use strict';
  let workerP = null;
  let progressCb = null;

  function abs(p) { return new URL(p, root.location.href).href.replace(/\/$/, ''); }

  function getWorker() {
    if (workerP) return workerP;
    if (!root.Tesseract) return Promise.reject(new Error('Text recognition is not available.'));
    workerP = root.Tesseract.createWorker('eng', 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/tesseract/core'),
      langPath: abs('vendor/tesseract/lang'),
      gzip: true,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m) => {
        if (progressCb && m.status === 'recognizing text') progressCb(m.progress || 0);
      },
    }).catch((e) => { workerP = null; throw e; });
    return workerP;
  }

  // image: canvas, Blob or URL. Returns { text, words: [{ text, x0, y0, x1, y1 }] }
  async function recognize(image, onProgress) {
    const w = await getWorker();
    progressCb = onProgress || null;
    try {
      const { data } = await w.recognize(image, {}, { text: true, blocks: true });
      const words = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
        if (wd.confidence < 35 || !wd.text.trim()) continue;
        words.push({ text: wd.text, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
      }
      return { text: (data.text || '').replace(/\n{3,}/g, '\n\n').trim(), words };
    } finally {
      progressCb = null;
    }
  }

  root.OCR = { recognize, warm: () => getWorker().catch(() => {}) };
})(typeof self !== 'undefined' ? self : this);
