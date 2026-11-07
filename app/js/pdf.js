/* Pagekeep PDF writer: JPEG pages, optional invisible OCR text layer (searchable PDF). No dependencies. */
(function (root) {
  'use strict';

  const PAGE_SIZES = {
    a4: { w: 595.28, h: 841.89, name: 'A4' },
    letter: { w: 612, h: 792, name: 'Letter' },
    legal: { w: 612, h: 1008, name: 'Legal' },
    fit: null, // page matches the image
  };

  function latin1(str) {
    let out = '';
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c === 0x2018 || c === 0x2019) out += "'";
      else if (c === 0x201c || c === 0x201d) out += '"';
      else if (c === 0x2013 || c === 0x2014) out += '-';
      else if (c >= 32 && c < 256 && c !== 127) out += ch;
      else out += ' ';
    }
    return out;
  }

  function pdfString(str) {
    return '(' + latin1(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
  }

  // PDF text strings (Info dictionary) as UTF-16BE hex, so any title works
  function pdfTextHex(str) {
    let hex = 'FEFF';
    for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0');
    return '<' + hex.toUpperCase() + '>';
  }

  const n2 = (v) => (Math.round(v * 100) / 100).toString();

  /* pages: [{ jpeg: Uint8Array, width, height (image px), words?: [{ text, x0, y0, x1, y1 } in image px] }]
   * opts: { pageSize: 'a4'|'letter'|'legal'|'fit', margin (pt), title, author }
   * returns Uint8Array */
  function buildPdf(pages, opts) {
    opts = opts || {};
    const chunks = [];
    let length = 0;
    const offsets = [];
    const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
    const write = (data) => { const b = typeof data === 'string' ? enc(data) : data; chunks.push(b); length += b.length; };
    const startObj = (n) => { offsets[n] = length; write(n + ' 0 obj\n'); };

    write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const nPages = pages.length;
    // object numbers: 1 catalog, 2 pages, 3 font, 4 info, then 3 per page (page, content, image)
    const pageObj = (i) => 5 + i * 3;
    const hasText = pages.some((p) => p.words && p.words.length);

    startObj(1); write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    startObj(2);
    write('<< /Type /Pages /Count ' + nPages + ' /Kids [' + pages.map((_, i) => pageObj(i) + ' 0 R').join(' ') + '] >>\nendobj\n');
    startObj(3); write('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
    startObj(4);
    write('<< /Producer (Pagekeep) /Title ' + pdfTextHex(opts.title || 'Scan') +
      (opts.author ? ' /Author ' + pdfTextHex(opts.author) : '') + ' >>\nendobj\n');

    pages.forEach((pg, i) => {
      const size = PAGE_SIZES[opts.pageSize || 'a4'];
      let pw, ph;
      if (!size) { pw = pg.width * 72 / 150; ph = pg.height * 72 / 150; } // 150 dpi
      else {
        const landscape = pg.width > pg.height;
        pw = landscape ? size.h : size.w; ph = landscape ? size.w : size.h;
      }
      const m = size ? (opts.margin || 0) : 0;
      const scale = Math.min((pw - 2 * m) / pg.width, (ph - 2 * m) / pg.height);
      const iw = pg.width * scale, ih = pg.height * scale;
      const ix = (pw - iw) / 2, iy = (ph - ih) / 2;

      let content = 'q ' + n2(iw) + ' 0 0 ' + n2(ih) + ' ' + n2(ix) + ' ' + n2(iy) + ' cm /Im0 Do Q\n';
      if (pg.words && pg.words.length) {
        content += 'BT 3 Tr\n';
        for (const wd of pg.words) {
          const text = latin1(wd.text).trim();
          if (!text) continue;
          const bw = (wd.x1 - wd.x0) * scale, bh = (wd.y1 - wd.y0) * scale;
          if (bw <= 0 || bh <= 0) continue;
          const fs = Math.max(1, bh * 0.92);
          const natural = text.length * fs * 0.5; // rough Helvetica advance
          const tz = Math.max(10, Math.min(500, (bw / natural) * 100));
          const x = ix + wd.x0 * scale, y = iy + ih - wd.y1 * scale + bh * 0.18;
          content += '/F1 ' + n2(fs) + ' Tf ' + n2(tz) + ' Tz 1 0 0 1 ' + n2(x) + ' ' + n2(y) + ' Tm ' + pdfString(text) + ' Tj\n';
        }
        content += 'ET\n';
      }

      const pn = pageObj(i);
      startObj(pn);
      write('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + n2(pw) + ' ' + n2(ph) + '] ' +
        '/Resources << /XObject << /Im0 ' + (pn + 2) + ' 0 R >>' + (hasText ? ' /Font << /F1 3 0 R >>' : '') + ' >> ' +
        '/Contents ' + (pn + 1) + ' 0 R >>\nendobj\n');
      startObj(pn + 1);
      write('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
      startObj(pn + 2);
      write('<< /Type /XObject /Subtype /Image /Width ' + pg.width + ' /Height ' + pg.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.jpeg.length + ' >>\nstream\n');
      write(pg.jpeg);
      write('\nendstream\nendobj\n');
    });

    const total = 5 + nPages * 3;
    const xref = length;
    let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let n = 1; n < total; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    write(x);
    write('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 4 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    const out = new Uint8Array(length);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  const api = { buildPdf, PAGE_SIZES, latin1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfWriter = api;
})(typeof self !== 'undefined' ? self : this);
