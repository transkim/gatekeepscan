/* Runs heavy page processing off the UI thread. */
importScripts('imgproc.js');

self.onmessage = (e) => {
  const { id, op, args } = e.data;
  try {
    let result;
    if (op === 'detect') {
      result = self.ImgProc.detectQuad(args.image);
      self.postMessage({ id, result });
      return;
    }
    if (op === 'render') {
      const { image, quad, maxSide, rotation, filter, brightness, contrast } = args;
      let img = image;
      if (quad) {
        const q = quad.map((p) => ({ x: p.x * image.width, y: p.y * image.height }));
        const size = self.ImgProc.outputSize(q, maxSide);
        img = self.ImgProc.warp(image, q, size.width, size.height);
      }
      if (rotation) img = self.ImgProc.rotate(img, rotation);
      img = self.ImgProc.applyFilter(img, filter, { brightness, contrast });
      self.postMessage({ id, result: img }, [img.data.buffer]);
      return;
    }
    if (op === 'filter') {
      const img = self.ImgProc.applyFilter(args.image, args.filter, args);
      self.postMessage({ id, result: img }, [img.data.buffer]);
      return;
    }
    throw new Error('unknown op ' + op);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
