/* Pagekeep UI */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const IP = window.ImgProc;
  const VERSION = '0.1.1';

  const state = {
    docs: [],
    doc: null,
    pages: [],
    sort: 'new',
    query: '',
    settings: { filter: 'vivid', auto: true, size: 'a4', prefix: 'Scan' },
  };

  // ---------- small UI helpers ----------
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  function show(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  }
  const current = () => (document.querySelector('.view.active') || {}).id;

  let openSheet = null;
  function sheet(id) {
    closeSheet();
    $('scrim').classList.remove('hidden');
    $(id).classList.remove('hidden');
    openSheet = id;
  }
  function closeSheet() {
    if (openSheet) $(openSheet).classList.add('hidden');
    $('scrim').classList.add('hidden');
    openSheet = null;
  }
  $('scrim').onclick = () => { if (!exportBusy) closeSheet(); };

  function menu(items) {
    const box = $('menu-items');
    box.innerHTML = '';
    items.forEach((it) => {
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      b.innerHTML = '<svg><use href="#i-' + it.icon + '"/></svg><span></span>';
      b.querySelector('span').textContent = it.label;
      b.onclick = () => { closeSheet(); it.run(); };
      box.appendChild(b);
    });
    sheet('sheet-menu');
  }

  function ask(title, msg, value, okLabel) {
    return new Promise((resolve) => {
      const m = $('modal-prompt');
      $('prompt-title').textContent = title;
      $('prompt-msg').textContent = msg || '';
      $('prompt-msg').classList.toggle('hidden', !msg);
      const inp = $('prompt-input');
      inp.classList.toggle('hidden', value === undefined || value === null);
      inp.value = value || '';
      $('prompt-ok').textContent = okLabel || 'OK';
      m.classList.remove('hidden');
      if (!inp.classList.contains('hidden')) setTimeout(() => { inp.focus(); inp.select(); }, 50);
      const done = (v) => { m.classList.add('hidden'); $('prompt-ok').onclick = $('prompt-cancel').onclick = inp.onkeydown = null; activeModal = null; resolve(v); };
      activeModal = () => done(null);
      $('prompt-ok').onclick = () => done(inp.classList.contains('hidden') ? true : inp.value.trim());
      $('prompt-cancel').onclick = () => done(null);
      inp.onkeydown = (e) => { if (e.key === 'Enter') $('prompt-ok').click(); };
    });
  }
  let activeModal = null;
  const confirmBox = (title, msg, okLabel) => ask(title, msg, null, okLabel || 'Delete');

  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '.' + p(d.getMinutes());
  };

  // object URLs for thumbnails, cached per page version
  const urlCache = new Map();
  function thumbURL(page) {
    if (!page || !page.thumb) return '';
    const key = page.id;
    const c = urlCache.get(key);
    if (c && c.v === page.updated) return c.url;
    if (c) URL.revokeObjectURL(c.url);
    const url = URL.createObjectURL(page.thumb);
    urlCache.set(key, { v: page.updated, url });
    return url;
  }

  async function saveSettings() { await DB.setKV('settings', state.settings); }

  // ---------- documents & pages ----------
  async function newDoc() {
    const now = Date.now();
    const doc = { id: DB.uid(), name: (state.settings.prefix || 'Scan') + ' ' + stamp(), created: now, updated: now, pages: [], textIndex: '', cover: null };
    await DB.putDoc(doc);
    return doc;
  }

  async function touchDoc(doc, pages) {
    doc.updated = Date.now();
    if (pages) {
      doc.cover = pages[0] ? pages[0].id : null;
      doc.textIndex = pages.map((p) => p.text || '').join('\n').slice(0, 20000);
    }
    await DB.putDoc(doc);
  }

  // capture: { blob, width, height, quad }
  async function createPage(doc, cap, opts) {
    const page = {
      id: DB.uid(), docId: doc.id, src: cap.blob, srcW: cap.width, srcH: cap.height,
      quad: cap.quad || null, rotation: 0, filter: (opts && opts.filter) || state.settings.filter,
      brightness: 0, contrast: 0, marks: [], text: '', words: null, created: Date.now(), updated: Date.now(),
    };
    await renderAndStore(page);
    Scan.forget(page.id);
    return page;
  }

  async function renderAndStore(page) {
    const r = await Scan.render(page);
    page.out = r.blob; page.thumb = r.thumb; page.outW = r.width; page.outH = r.height;
    page.updated = Date.now();
    await DB.putPage(page);
    return page;
  }

  async function addCaptures(doc, caps, opts) {
    const total = caps.length;
    for (let i = 0; i < total; i++) {
      toast('Processing page ' + (i + 1) + ' of ' + total + '…', 60000);
      const page = await createPage(doc, caps[i], opts);
      doc.pages.push(page.id);
      await DB.putDoc(doc);
    }
    $('toast').classList.add('hidden');
    const pages = await DB.getPages(doc);
    await touchDoc(doc, pages);
  }

  // ---------- library ----------
  async function loadLibrary() {
    state.docs = await DB.listDocs();
    await renderLibrary();
  }

  function snippet(text, q) {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return null;
    const start = Math.max(0, i - 30);
    const frag = (start ? '…' : '') + text.slice(start, i + q.length + 60).replace(/\s+/g, ' ');
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const j = frag.toLowerCase().indexOf(q);
    return esc(frag.slice(0, j)) + '<mark>' + esc(frag.slice(j, j + q.length)) + '</mark>' + esc(frag.slice(j + q.length));
  }

  let libToken = 0;
  async function renderLibrary() {
    const token = ++libToken;
    const q = state.query.trim().toLowerCase();
    let docs = state.docs.slice();
    if (state.sort === 'name') docs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const list = $('doc-list');
    const items = [];
    for (const d of docs) {
      let snip = null;
      if (q) {
        const inName = d.name.toLowerCase().includes(q);
        snip = snippet(d.textIndex || '', q);
        if (!inName && !snip) continue;
      }
      items.push({ d, snip });
    }
    const covers = await Promise.all(items.map(({ d }) => (d.cover ? DB.getPage(d.cover) : null)));
    if (token !== libToken) return;
    list.innerHTML = '';
    items.forEach(({ d, snip }, i) => {
      const card = document.createElement('div');
      card.className = 'doc-card';
      card.innerHTML =
        '<div class="thumb"><img alt=""><span class="count"><svg><use href="#i-pages"/></svg><b></b></span></div>' +
        '<div class="info"><div><div class="name"></div><div class="date"></div>' + (snip ? '<div class="snippet">' + snip + '</div>' : '') + '</div>' +
        '<button class="menu-btn" aria-label="Options"><svg><use href="#i-more"/></svg></button></div>';
      const url = thumbURL(covers[i]);
      if (url) card.querySelector('img').src = url;
      card.querySelector('b').textContent = d.pages.length;
      card.querySelector('.name').textContent = d.name;
      card.querySelector('.date').textContent = fmtDate(d.updated);
      card.onclick = (e) => {
        if (e.target.closest('.menu-btn')) return docMenu(d);
        openDoc(d.id);
      };
      list.appendChild(card);
    });
    const total = state.docs.length;
    $('lib-empty').classList.toggle('hidden', total > 0);
    $('lib-summary').textContent = total
      ? (q ? items.length + ' of ' + total + ' documents' : total + (total === 1 ? ' document' : ' documents')) +
        (state.sort === 'name' ? ' · A to Z' : ' · newest first')
      : '';
  }

  function docMenu(d) {
    menu([
      { icon: 'pages', label: 'Open', run: () => openDoc(d.id) },
      { icon: 'edit', label: 'Rename', run: () => renameDoc(d) },
      { icon: 'pdf', label: 'Share as PDF', run: async () => { await openDoc(d.id); openExport(); } },
      { icon: 'trash', label: 'Delete', danger: true, run: () => deleteDoc(d) },
    ]);
  }

  async function renameDoc(d) {
    const name = await ask('Rename', null, d.name, 'Save');
    if (!name) return;
    d.name = name;
    await touchDoc(d);
    if (state.doc && state.doc.id === d.id) { state.doc.name = name; $('doc-name').textContent = name; }
    await loadLibrary();
  }

  async function deleteDoc(d) {
    const ok = await confirmBox('Delete "' + d.name + '"?', 'Its ' + d.pages.length + ' page(s) will be removed from this device.');
    if (!ok) return;
    await DB.deleteDoc(d);
    if (state.doc && state.doc.id === d.id) { state.doc = null; show('v-library'); }
    await loadLibrary();
    toast('Deleted');
  }

  $('search').oninput = (e) => { state.query = e.target.value; renderLibrary(); };
  $('btn-sort').onclick = () => { state.sort = state.sort === 'new' ? 'name' : 'new'; renderLibrary(); };
  $('btn-scan').onclick = () => openCamera(null);
  $('btn-import').onclick = () => pickFiles(null);

  // ---------- import ----------
  let importTarget = null;
  function pickFiles(docId) {
    importTarget = docId;
    $('file-input').value = '';
    $('file-input').click();
  }
  $('file-input').onchange = async (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp|gif)$/i.test(f.name));
    if (!files.length) return;
    await importFiles(files, importTarget);
  };
  $('file-capture').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    stopCamera();
    await importFiles(files, camera.target, files.length === 1);
  };

  async function importFiles(files, docId, single) {
    try {
      const caps = [];
      for (let i = 0; i < files.length; i++) {
        toast('Reading ' + (i + 1) + ' of ' + files.length + '…', 60000);
        const n = await Scan.normalize(files[i]);
        const quad = await Scan.detect(n.canvas);
        caps.push({ blob: n.blob, width: n.width, height: n.height, quad });
      }
      $('toast').classList.add('hidden');
      if (caps.length === 1 && (single || !docId)) {
        return cropNew(caps[0], docId);
      }
      const doc = docId ? await DB.getDoc(docId) : await newDoc();
      await addCaptures(doc, caps);
      await openDoc(doc.id);
      toast(caps.length + ' page(s) added');
    } catch (err) {
      toast('Could not import: ' + err.message, 4000);
    }
  }

  // ---------- camera ----------
  const camera = {
    stream: null, track: null, timer: null, busy: false, mode: 'batch', target: null,
    captures: [], quad: null, display: null, history: [], lastShot: 0, torch: false, capturing: false,
  };

  async function openCamera(docId) {
    camera.target = docId;
    camera.captures = [];
    camera.quad = camera.display = null;
    camera.history = [];
    updateStack();
    $('cam-auto').setAttribute('aria-pressed', String(!!state.settings.auto));
    setMode(camera.mode);
    show('v-camera');
    Platform.keepAwake(true);
    $('cam-msg').classList.add('hidden');
    const v = $('cam-video');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no camera api');
      camera.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      if (current() !== 'v-camera') { stopCamera(); return; }
      camera.track = camera.stream.getVideoTracks()[0];
      v.srcObject = camera.stream;
      await v.play();
      try { await camera.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) { /* optional */ }
      const caps = camera.track.getCapabilities ? camera.track.getCapabilities() : {};
      $('cam-torch').classList.toggle('hidden', !caps.torch);
      camera.timer = setInterval(detectTick, 200);
      $('cam-hint').textContent = 'Looking for a page…';
    } catch (err) {
      const m = $('cam-msg');
      m.innerHTML = '<div>The camera could not be opened here.</div><button class="btn primary" id="cam-native">Use the camera app</button><button class="btn" id="cam-pick">Pick photos</button>';
      m.classList.remove('hidden');
      $('cam-native').onclick = () => { $('file-capture').value = ''; $('file-capture').click(); };
      $('cam-pick').onclick = () => { stopCamera(); pickFiles(camera.target); };
      $('cam-hint').textContent = '';
    }
  }

  function stopCamera() {
    clearInterval(camera.timer); camera.timer = null;
    if (camera.stream) camera.stream.getTracks().forEach((t) => t.stop());
    camera.stream = camera.track = null;
    $('cam-video').srcObject = null;
    camera.torch = false;
    $('cam-torch').classList.remove('on');
    Platform.keepAwake(false);
    const c = $('cam-overlay');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  function closeCamera() {
    stopCamera();
    if (camera.captures.length && camera.mode === 'batch') return finishCapture();
    if (camera.target) show('v-doc'); else { show('v-library'); loadLibrary(); }
  }

  function setMode(mode) {
    camera.mode = mode;
    document.querySelectorAll('.cam-modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    updateStack();
  }
  document.querySelectorAll('.cam-modes button').forEach((b) => {
    b.onclick = () => {
      if (camera.captures.length && b.dataset.mode !== camera.mode) return toast('Finish these pages first');
      setMode(b.dataset.mode);
      $('cam-hint').textContent = b.dataset.mode === 'id' ? 'Scan the front of the card' : 'Looking for a page…';
    };
  });

  function updateStack() {
    const n = camera.captures.length;
    $('cam-done').classList.toggle('hidden', !n);
    $('cam-spacer').classList.toggle('hidden', !!n);
    $('cam-count').textContent = n;
    if (n) {
      const last = camera.captures[n - 1];
      if (last.url) $('cam-stack-img').src = last.url;
    }
  }

  function videoRect() {
    const v = $('cam-video'), c = $('cam-overlay');
    const cw = c.clientWidth, ch = c.clientHeight, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(cw / vw, ch / vh);
    return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
  }

  function drawOverlay(stableFrac) {
    const c = $('cam-overlay');
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(c.clientWidth * dpr)) { c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    const r = videoRect();
    const q = camera.display;
    if (!r || !q) return;
    const pts = q.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fillStyle = 'rgba(238,106,52,0.16)';
    g.fill();
    g.lineWidth = 3 + stableFrac * 3;
    g.strokeStyle = stableFrac >= 1 ? '#ffffff' : '#ee6a34';
    g.stroke();
    pts.forEach((p) => {
      g.beginPath(); g.arc(p.x, p.y, 7, 0, Math.PI * 2);
      g.fillStyle = '#fff'; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#ee6a34'; g.stroke();
    });
  }

  async function detectTick() {
    const v = $('cam-video');
    if (camera.busy || camera.capturing || !v.videoWidth || current() !== 'v-camera') return;
    camera.busy = true;
    try {
      const q = await Scan.detect(v);
      if (q) {
        camera.quad = q;
        camera.display = camera.display
          ? camera.display.map((p, i) => ({ x: p.x * 0.4 + q[i].x * 0.6, y: p.y * 0.4 + q[i].y * 0.6 }))
          : q;
        camera.history.push(q);
        if (camera.history.length > 6) camera.history.shift();
      } else {
        camera.misses = (camera.misses || 0) + 1;
        if (camera.misses > 3) { camera.quad = camera.display = null; camera.history = []; camera.misses = 0; }
      }
      if (q) camera.misses = 0;
      // stability: how many recent detections agree with the latest one
      let stable = 0;
      if (camera.quad && camera.history.length) {
        const last = camera.history[camera.history.length - 1];
        for (let i = camera.history.length - 1; i >= 0; i--) {
          const h = camera.history[i];
          const d = Math.max(...h.map((p, k) => Math.hypot(p.x - last[k].x, p.y - last[k].y)));
          if (d < 0.02) stable++; else break;
        }
      }
      const frac = Math.min(1, stable / 6);
      drawOverlay(frac);
      $('cam-shutter').classList.toggle('ready', !!camera.quad);
      const hint = $('cam-hint');
      if (!camera.quad) hint.textContent = camera.mode === 'id' && camera.captures.length === 1 ? 'Now scan the back' : camera.mode === 'id' ? 'Scan the front of the card' : 'Looking for a page…';
      else if (state.settings.auto && frac < 1) hint.textContent = 'Hold steady…';
      else hint.textContent = state.settings.auto ? 'Capturing' : 'Page found. Tap to capture';
      if (state.settings.auto && frac >= 1 && Date.now() - camera.lastShot > 2200) capture();
    } catch (_) { /* keep looking */ }
    camera.busy = false;
  }

  async function capture() {
    const v = $('cam-video');
    if (!v.videoWidth || camera.capturing) return;
    camera.capturing = true;
    camera.lastShot = Date.now();
    Platform.tap();
    const f = $('cam-flash');
    f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60);
    try {
      const frame = Scan.toCanvas(v);
      const n = await Scan.normalize(frame);
      const quad = (await Scan.detect(n.canvas)) || camera.quad;
      const cap = { blob: n.blob, width: n.width, height: n.height, quad, url: Scan.toCanvas(n.canvas, 160).toDataURL('image/jpeg', 0.6) };
      camera.history = [];
      if (camera.mode === 'single') {
        stopCamera();
        camera.capturing = false;
        return cropNew(cap, camera.target);
      }
      camera.captures.push(cap);
      updateStack();
      if (camera.mode === 'id' && camera.captures.length >= 2) {
        camera.capturing = false;
        return finishCapture();
      }
      if (camera.mode === 'id') toast('Front saved. Turn the card over.');
    } catch (err) {
      toast('Capture failed: ' + err.message);
    }
    camera.capturing = false;
  }

  async function finishCapture() {
    const caps = camera.captures.slice();
    camera.captures = [];
    stopCamera();
    if (!caps.length) return closeCamera();
    const doc = camera.target ? await DB.getDoc(camera.target) : await newDoc();
    if (camera.mode === 'id') {
      toast('Building the card page…', 60000);
      const sides = [];
      for (const c of caps) sides.push(await Scan.cropToCanvas(c.blob, c.quad));
      const page = await Scan.composeCards(sides);
      const blob = await Scan.toBlob(page, 'image/jpeg', 0.92);
      await addCaptures(doc, [{ blob, width: page.width, height: page.height, quad: null }], { filter: 'auto' });
      if (!camera.target && doc.name.startsWith(state.settings.prefix || 'Scan')) { doc.name = 'ID card ' + stamp(); await DB.putDoc(doc); }
    } else {
      await addCaptures(doc, caps);
    }
    await openDoc(doc.id);
  }

  $('cam-shutter').onclick = capture;
  $('cam-close').onclick = closeCamera;
  $('cam-done').onclick = finishCapture;
  $('cam-import').onclick = () => { const t = camera.target; stopCamera(); pickFiles(t); };
  $('cam-auto').onclick = async () => {
    state.settings.auto = !state.settings.auto;
    $('cam-auto').setAttribute('aria-pressed', String(state.settings.auto));
    toast(state.settings.auto ? 'Auto capture on' : 'Auto capture off');
    await saveSettings();
  };
  $('cam-torch').onclick = async () => {
    camera.torch = !camera.torch;
    try { await camera.track.applyConstraints({ advanced: [{ torch: camera.torch }] }); } catch (_) { camera.torch = false; }
    $('cam-torch').classList.toggle('on', camera.torch);
  };

  // ---------- crop ----------
  const crop = { canvas: null, quad: null, rect: null, drag: null, onDone: null, onCancel: null };
  const FULL = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  async function openCrop(blob, quad, onDone, onCancel, title) {
    show('v-crop');
    $('crop-title').textContent = title || 'Adjust corners';
    const bmp = await Scan.decode(blob);
    crop.canvas = Scan.toCanvas(bmp, 1600);
    crop.quad = (quad || FULL()).map((p) => ({ x: p.x, y: p.y }));
    crop.onDone = onDone; crop.onCancel = onCancel;
    layoutCrop();
  }

  function layoutCrop() {
    if (!crop.canvas) return;
    const stage = $('crop-stage');
    const sw = stage.clientWidth, sh = stage.clientHeight, pad = 28;
    const k = Math.min((sw - pad * 2) / crop.canvas.width, (sh - pad * 2) / crop.canvas.height);
    const w = crop.canvas.width * k, h = crop.canvas.height * k;
    crop.rect = { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
    const c = $('crop-img');
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    Object.assign(c.style, { left: crop.rect.x + 'px', top: crop.rect.y + 'px', width: w + 'px', height: h + 'px' });
    c.getContext('2d').drawImage(crop.canvas, 0, 0, c.width, c.height);
    const s = $('crop-svg');
    Object.assign(s.style, { left: 0, top: 0, width: sw + 'px', height: sh + 'px' });
    s.setAttribute('viewBox', '0 0 ' + sw + ' ' + sh);
    drawCrop();
  }

  function cropPts() {
    const r = crop.rect;
    return crop.quad.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
  }

  function drawCrop() {
    const r = crop.rect, pts = cropPts();
    const poly = pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
    let html = '<path class="crop-shade" d="M' + r.x + ' ' + r.y + 'h' + r.w + 'v' + r.h + 'h' + -r.w + 'z M' + pts.map((p) => p.x + ' ' + p.y).join(' L') + 'z"/>';
    html += '<polygon class="crop-edge" points="' + poly + '"/>';
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      html += '<rect class="crop-mid" x="' + ((a.x + b.x) / 2 - 9) + '" y="' + ((a.y + b.y) / 2 - 4) + '" width="18" height="8" rx="4" transform="rotate(' +
        (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI) + ' ' + (a.x + b.x) / 2 + ' ' + (a.y + b.y) / 2 + ')"/>';
    }
    pts.forEach((p) => { html += '<circle class="crop-handle" cx="' + p.x + '" cy="' + p.y + '" r="11"/>'; });
    $('crop-svg').innerHTML = html;
  }

  function drawLoupe(pt) {
    const l = $('crop-loupe');
    l.classList.remove('hidden');
    const r = crop.rect, stage = $('crop-stage');
    // keep the loupe away from the finger: top-left, or top-right when the finger is up there
    const onRight = pt.x < 160 && pt.y < 170;
    l.style.left = onRight ? (stage.clientWidth - 132) + 'px' : '12px';
    const g = l.getContext('2d');
    const k = crop.canvas.width / r.w;               // source px per screen px
    const sx = (pt.x - r.x) * k, sy = (pt.y - r.y) * k;
    const span = (120 / 2.5) * k;                     // 2.5x magnification
    g.fillStyle = '#000'; g.fillRect(0, 0, l.width, l.height);
    g.drawImage(crop.canvas, sx - span / 2, sy - span / 2, span, span, 0, 0, l.width, l.height);
    g.strokeStyle = '#ee6a34'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(l.width / 2 - 14, l.height / 2); g.lineTo(l.width / 2 + 14, l.height / 2);
    g.moveTo(l.width / 2, l.height / 2 - 14); g.lineTo(l.width / 2, l.height / 2 + 14); g.stroke();
  }

  const stageXY = (e) => { const b = $('crop-stage').getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  $('crop-stage').addEventListener('pointerdown', (e) => {
    if (!crop.rect) return;
    const p = stageXY(e), pts = cropPts();
    let best = null, bd = 40;
    pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = { type: 'corner', i }; } });
    if (!best) {
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        const d = Math.hypot((a.x + b.x) / 2 - p.x, (a.y + b.y) / 2 - p.y);
        if (d < bd) { bd = d; best = { type: 'edge', i }; }
      }
    }
    if (!best) return;
    crop.drag = Object.assign(best, { last: p });
    $('crop-stage').setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  $('crop-stage').addEventListener('pointermove', (e) => {
    if (!crop.drag) return;
    const p = stageXY(e), r = crop.rect;
    const dx = (p.x - crop.drag.last.x) / r.w, dy = (p.y - crop.drag.last.y) / r.h;
    crop.drag.last = p;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const move = (i) => { crop.quad[i] = { x: clamp(crop.quad[i].x + dx), y: clamp(crop.quad[i].y + dy) }; };
    if (crop.drag.type === 'corner') move(crop.drag.i);
    else { move(crop.drag.i); move((crop.drag.i + 1) % 4); }
    drawCrop();
    const i = crop.drag.i, pts = cropPts();
    drawLoupe(crop.drag.type === 'corner' ? pts[i] : { x: (pts[i].x + pts[(i + 1) % 4].x) / 2, y: (pts[i].y + pts[(i + 1) % 4].y) / 2 });
  });
  const endDrag = () => { crop.drag = null; $('crop-loupe').classList.add('hidden'); };
  $('crop-stage').addEventListener('pointerup', endDrag);
  $('crop-stage').addEventListener('pointercancel', endDrag);
  $('crop-auto').onclick = async () => {
    const q = await Scan.detect(crop.canvas);
    if (q) { crop.quad = q; drawCrop(); } else toast('No page edges found. Drag the corners instead.');
  };
  $('crop-full').onclick = () => { crop.quad = FULL(); drawCrop(); };
  $('crop-cancel').onclick = () => { const f = crop.onCancel; crop.canvas = null; if (f) f(); };
  $('crop-ok').onclick = () => {
    let q = crop.quad;
    const area = IP.polyArea(q);
    if (area < 0.01) return toast('That area is too small');
    q = IP.orderQuad(q);
    const isFull = q.every((p, i) => Math.abs(p.x - FULL()[i].x) < 0.002 && Math.abs(p.y - FULL()[i].y) < 0.002);
    const f = crop.onDone;
    crop.canvas = null;
    if (f) f(isFull ? null : q);
  };
  window.addEventListener('resize', () => {
    if (current() === 'v-crop') layoutCrop();
    if (current() === 'v-page') positionSig();
  });

  function cropNew(cap, docId) {
    openCrop(cap.blob, cap.quad, async (quad) => {
      const doc = docId ? await DB.getDoc(docId) : await newDoc();
      cap.quad = quad;
      await addCaptures(doc, [cap]);
      await openDoc(doc.id);
      openPage(state.pages.length - 1);
    }, () => {
      if (docId) show('v-doc'); else { show('v-library'); loadLibrary(); }
    });
  }

  // ---------- document ----------
  async function openDoc(id) {
    const doc = await DB.getDoc(id);
    if (!doc) { show('v-library'); return loadLibrary(); }
    state.doc = doc;
    state.pages = await DB.getPages(doc);
    renderDoc();
    show('v-doc');
  }

  function renderDoc() {
    const doc = state.doc;
    $('doc-name').textContent = doc.name;
    const withText = state.pages.filter((p) => p.text).length;
    $('doc-meta').textContent = state.pages.length + (state.pages.length === 1 ? ' page' : ' pages') + ' · ' + fmtDate(doc.updated) +
      (withText ? ' · text on ' + withText : '');
    const grid = $('page-grid');
    grid.innerHTML = '';
    state.pages.forEach((p, i) => {
      const t = document.createElement('div');
      t.className = 'page-tile';
      t.dataset.id = p.id;
      t.innerHTML = '<img alt=""><span class="num">' + (i + 1) + '</span>' + (p.text ? '<span class="ocr-dot">Aa</span>' : '');
      t.querySelector('img').src = thumbURL(p);
      attachTileDrag(t, i);
      grid.appendChild(t);
    });
    const add = document.createElement('button');
    add.className = 'add-tile';
    add.setAttribute('aria-label', 'Add pages');
    add.innerHTML = '<svg><use href="#i-plus"/></svg>';
    add.onclick = addMenu;
    grid.appendChild(add);
  }

  function attachTileDrag(tile, index) {
    let timer = null, start = null, dragging = false, ghost = null;
    tile.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        dragging = true;
        Platform.tap();
        tile.classList.add('dragging');
        ghost = document.createElement('div');
        ghost.className = 'page-ghost';
        ghost.innerHTML = '<img src="' + tile.querySelector('img').src + '">';
        document.body.appendChild(ghost);
        moveGhost(e.clientX, e.clientY);
        try { tile.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }, 380);
    });
    const moveGhost = (x, y) => { if (ghost) { ghost.style.left = (x - 60) + 'px'; ghost.style.top = (y - 80) + 'px'; } };
    tile.addEventListener('pointermove', (e) => {
      if (!dragging) {
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { clearTimeout(timer); start = null; }
        return;
      }
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
      ghost.style.display = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      ghost.style.display = '';
      const target = under && under.closest('.page-tile');
      if (target && target !== tile) {
        const grid = $('page-grid');
        const tiles = Array.from(grid.querySelectorAll('.page-tile'));
        if (tiles.indexOf(target) > tiles.indexOf(tile)) target.after(tile); else target.before(tile);
      }
    });
    const finish = async () => {
      clearTimeout(timer);
      if (!dragging) {
        if (start) openPage(Array.from($('page-grid').querySelectorAll('.page-tile')).indexOf(tile));
        start = null;
        return;
      }
      dragging = false; start = null;
      if (ghost) ghost.remove();
      ghost = null;
      tile.classList.remove('dragging');
      const order = Array.from($('page-grid').querySelectorAll('.page-tile')).map((t) => t.dataset.id);
      if (order.join() !== state.doc.pages.join()) {
        state.doc.pages = order;
        state.pages = order.map((id) => state.pages.find((p) => p.id === id));
        await touchDoc(state.doc, state.pages);
      }
      renderDoc();
    };
    tile.addEventListener('pointerup', finish);
    tile.addEventListener('pointercancel', () => { clearTimeout(timer); start = null; if (dragging) finish(); });
    tile.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function addMenu() {
    menu([
      { icon: 'scan', label: 'Scan with camera', run: () => openCamera(state.doc.id) },
      { icon: 'image', label: 'Import photos', run: () => pickFiles(state.doc.id) },
    ]);
  }

  $('doc-back').onclick = () => { state.doc = null; show('v-library'); loadLibrary(); };
  $('doc-title').onclick = () => renameDoc(state.doc);
  $('doc-add').onclick = addMenu;
  $('doc-pdf').onclick = () => openExport();
  $('doc-text').onclick = () => openText(null);
  $('doc-sign').onclick = () => { if (state.pages.length) openPage(state.pages.length - 1, 'sign'); };
  $('doc-share').onclick = () => menu([
    { icon: 'pdf', label: 'PDF', run: () => openExport() },
    { icon: 'image', label: 'Images (JPEG)', run: () => shareImages(false) },
    { icon: 'text', label: 'Text', run: () => openText(null) },
  ]);
  $('doc-more').onclick = () => menu([
    { icon: 'edit', label: 'Rename', run: () => renameDoc(state.doc) },
    { icon: 'save', label: 'Save pages as images', run: () => shareImages(true) },
    { icon: 'trash', label: 'Delete document', danger: true, run: () => deleteDoc(state.doc) },
  ]);

  async function shareImages(save) {
    const files = state.pages.map((p, i) => ({ blob: p.out, name: state.doc.name + ' - ' + (i + 1) + '.jpg' }));
    if (save) {
      let where = '';
      for (const f of files) where = await Platform.save(f.blob, f.name);
      toast('Saved ' + files.length + ' image(s) to ' + where.replace(/\/[^/]*$/, ''), 3500);
    } else {
      await Platform.shareFiles(files, state.doc.name);
    }
  }

  // ---------- page editor ----------
  const ed = { idx: 0, page: null, dirty: false, token: 0, timer: null, sig: null, previewsFor: null };

  async function openPage(idx, tool) {
    if (ed.page && ed.dirty) await commitPage();
    ed.idx = Math.max(0, Math.min(state.pages.length - 1, idx));
    ed.page = Object.assign({}, state.pages[ed.idx]);
    ed.dirty = false;
    show('v-page');
    $('page-title').textContent = 'Page ' + (ed.idx + 1) + ' of ' + state.pages.length;
    $('page-prev').disabled = ed.idx === 0;
    $('page-next').disabled = ed.idx >= state.pages.length - 1;
    $('adj-bright').value = ed.page.brightness || 0;
    $('adj-contrast').value = ed.page.contrast || 0;
    closeSig(false);
    // show the stored page at once, then the live render
    const img = await Scan.decode(ed.page.out);
    const c = $('page-canvas');
    c.width = Scan.dims(img).w; c.height = Scan.dims(img).h;
    c.getContext('2d').drawImage(img, 0, 0);
    setTool(tool || 'filter');
    buildFilterStrip();
  }

  function setTool(tool) {
    ['filter', 'adjust', 'sign'].forEach((t) => {
      $('tool-' + t).classList.toggle('on', t === tool);
      $('panel-' + (t === 'filter' ? 'filters' : t)).classList.toggle('hidden', t !== tool);
    });
    if (tool === 'sign') startSign();
    else closeSig(false);
  }

  async function buildFilterStrip() {
    const strip = $('filter-strip');
    const page = ed.page;
    const key = page.id + ':' + JSON.stringify(page.quad) + ':' + page.rotation;
    if (ed.previewsFor !== key) {
      strip.innerHTML = IP.FILTERS.map((f) => '<button data-f="' + f.id + '"><img alt=""><span>' + f.name + '</span></button>').join('');
      strip.querySelectorAll('button').forEach((b) => { b.onclick = () => chooseFilter(b.dataset.f); });
      ed.previewsFor = key;
      Scan.filterPreviews(page, 80).then((prev) => {
        if (ed.previewsFor !== key) return;
        strip.querySelectorAll('button').forEach((b) => { b.querySelector('img').src = prev[b.dataset.f]; });
      }).catch(() => {});
    }
    strip.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === page.filter));
  }

  function chooseFilter(f) {
    ed.page.filter = f;
    buildFilterStrip();
    changed();
  }

  function changed(geometry) {
    ed.dirty = true;
    if (geometry) { ed.page.text = ''; ed.page.words = null; }
    clearTimeout(ed.timer);
    ed.timer = setTimeout(renderPreview, 120);
  }

  async function renderPreview() {
    if (!ed.page) return;
    const token = ++ed.token;
    $('page-busy').classList.remove('hidden');
    try {
      const r = await Scan.render(withoutEditingSig(ed.page), { preview: true, maxSide: 1600 });
      if (token !== ed.token) return;
      const c = $('page-canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      positionSig();
    } catch (err) {
      toast('Could not process: ' + err.message);
    } finally {
      if (token === ed.token) $('page-busy').classList.add('hidden');
    }
  }

  function withoutEditingSig(page) {
    if (!ed.sig || ed.sig.index < 0) return page;
    return Object.assign({}, page, { marks: page.marks.filter((_, i) => i !== ed.sig.index) });
  }

  async function commitPage() {
    if (!ed.page) return;
    closeSig(true);
    if (!ed.dirty) return;
    $('page-busy').classList.remove('hidden');
    try {
      const page = ed.page;
      await renderAndStore(page);
      state.pages[state.pages.findIndex((p) => p.id === page.id)] = page;
      await touchDoc(state.doc, state.pages);
      ed.dirty = false;
    } finally {
      $('page-busy').classList.add('hidden');
    }
  }

  $('page-back').onclick = async () => {
    clearTimeout(ed.timer);
    await commitPage();
    if (ed.page) Scan.forget(ed.page.id);
    ed.page = null;
    renderDoc();
    show('v-doc');
  };
  $('page-prev').onclick = () => openPage(ed.idx - 1);
  $('page-next').onclick = () => openPage(ed.idx + 1);
  $('page-delete').onclick = async () => {
    const ok = await confirmBox('Delete this page?', null);
    if (!ok) return;
    const id = ed.page.id;
    ed.page = null; ed.dirty = false;
    await DB.deletePage(id);
    state.doc.pages = state.doc.pages.filter((x) => x !== id);
    state.pages = state.pages.filter((p) => p.id !== id);
    if (!state.pages.length) {
      await DB.deleteDoc(state.doc);
      state.doc = null;
      show('v-library'); loadLibrary();
      return toast('Document removed (no pages left)');
    }
    await touchDoc(state.doc, state.pages);
    openPage(Math.min(ed.idx, state.pages.length - 1));
  };
  $('tool-filter').onclick = () => setTool('filter');
  $('tool-adjust').onclick = () => setTool('adjust');
  $('tool-sign').onclick = () => setTool('sign');
  $('tool-rotate').onclick = () => {
    ed.page.rotation = ((ed.page.rotation || 0) + 90) % 360;
    // signatures are placed on the finished page; drop them when turning it
    if (ed.page.marks && ed.page.marks.length) { ed.page.marks = []; toast('Signature removed. Add it again after turning.'); }
    changed(true);
    buildFilterStrip();
  };
  $('tool-crop').onclick = () => {
    const page = ed.page;
    openCrop(page.src, page.quad, (quad) => {
      page.quad = quad;
      show('v-page');
      changed(true);
      buildFilterStrip();
    }, () => show('v-page'));
  };
  $('tool-text').onclick = () => openText(ed.page);
  $('adj-bright').oninput = (e) => { ed.page.brightness = Number(e.target.value); changed(); };
  $('adj-contrast').oninput = (e) => { ed.page.contrast = Number(e.target.value); changed(); };
  $('adj-reset').onclick = () => { ed.page.brightness = ed.page.contrast = 0; $('adj-bright').value = 0; $('adj-contrast').value = 0; changed(); };

  // ---------- signatures ----------
  async function startSign() {
    if (ed.sig) return;
    const marks = ed.page.marks || [];
    if (marks.length) {
      // edit the last one
      const i = marks.length - 1;
      ed.sig = Object.assign({ index: i }, marks[i]);
      renderPreview();
      return showSig();
    }
    const png = await DB.getKV('signature');
    if (!png) return openSignPad();
    placeSig(png);
  }

  function placeSig(png) {
    const img = new Image();
    img.onload = () => {
      const c = $('page-canvas');
      const w = 0.32, h = w * (img.height / img.width) * (c.width / c.height);
      ed.sig = { index: -1, png, x: 0.6, y: Math.min(0.9 - h, 0.78), w, h };
      showSig();
    };
    img.src = png;
  }

  function showSig() {
    const layer = $('sig-layer');
    layer.innerHTML = '<div class="sig-box"><img alt=""><span class="rs"></span></div>';
    layer.querySelector('img').src = ed.sig.png;
    const box = layer.firstChild;
    let mode = null, last = null;
    box.addEventListener('pointerdown', (e) => {
      mode = e.target.classList.contains('rs') ? 'resize' : 'move';
      last = { x: e.clientX, y: e.clientY };
      box.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    box.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const c = $('page-canvas').getBoundingClientRect();
      const dx = (e.clientX - last.x) / c.width, dy = (e.clientY - last.y) / c.height;
      last = { x: e.clientX, y: e.clientY };
      const s = ed.sig;
      if (mode === 'move') {
        s.x = Math.min(1 - s.w, Math.max(0, s.x + dx));
        s.y = Math.min(1 - s.h, Math.max(0, s.y + dy));
      } else {
        const ratio = s.h / s.w;
        s.w = Math.min(1 - s.x, Math.max(0.06, s.w + dx));
        s.h = s.w * ratio;
      }
      positionSig();
    });
    const up = () => { mode = null; };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    positionSig();
  }

  function positionSig() {
    const box = document.querySelector('#sig-layer .sig-box');
    if (!box || !ed.sig) return;
    const c = $('page-canvas'), wrap = $('page-wrap').getBoundingClientRect(), r = c.getBoundingClientRect();
    Object.assign(box.style, {
      left: (r.left - wrap.left + ed.sig.x * r.width) + 'px', top: (r.top - wrap.top + ed.sig.y * r.height) + 'px',
      width: (ed.sig.w * r.width) + 'px', height: (ed.sig.h * r.height) + 'px',
    });
  }

  function closeSig(apply) {
    const s = ed.sig;
    $('sig-layer').innerHTML = '';
    ed.sig = null;
    if (!s || !ed.page) return;
    if (apply) {
      const m = { png: s.png, x: s.x, y: s.y, w: s.w, h: s.h };
      ed.page.marks = (ed.page.marks || []).slice();
      if (s.index >= 0) ed.page.marks[s.index] = m; else ed.page.marks.push(m);
      ed.dirty = true;
    }
  }

  $('sign-new').onclick = () => { $('sig-layer').innerHTML = ''; const s = ed.sig; ed.sig = null; if (s && s.index >= 0) { ed.page.marks = ed.page.marks.filter((_, i) => i !== s.index); renderPreview(); } openSignPad(); };
  $('sign-done').onclick = () => { closeSig(true); setTool('filter'); changed(); };
  $('sign-remove').onclick = () => {
    const s = ed.sig;
    $('sig-layer').innerHTML = ''; ed.sig = null;
    if (s && s.index >= 0) { ed.page.marks = ed.page.marks.filter((_, i) => i !== s.index); }
    setTool('filter');
    changed();
  };

  // signature pad
  const pad = { color: '#111111', strokes: [], drawing: null };
  function openSignPad() {
    $('modal-sign').classList.remove('hidden');
    activeModal = () => { $('modal-sign').classList.add('hidden'); setTool('filter'); };
    const c = $('sign-pad');
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    pad.strokes = [];
    redrawPad();
  }
  function redrawPad() {
    const c = $('sign-pad'), g = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    g.clearRect(0, 0, c.width, c.height);
    g.lineCap = g.lineJoin = 'round';
    for (const s of pad.strokes) {
      g.strokeStyle = s.color;
      g.beginPath();
      s.pts.forEach((p, i) => {
        g.lineWidth = Math.max(1.5, 4.2 - (p.v || 0) * 1.6) * dpr;
        if (i) { g.lineTo(p.x * dpr, p.y * dpr); g.stroke(); g.beginPath(); }
        g.moveTo(p.x * dpr, p.y * dpr);
      });
    }
  }
  const padXY = (e) => { const b = $('sign-pad').getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top, t: performance.now() }; };
  $('sign-pad').addEventListener('pointerdown', (e) => {
    pad.drawing = { color: pad.color, pts: [padXY(e)] };
    pad.strokes.push(pad.drawing);
    $('sign-pad').setPointerCapture(e.pointerId);
  });
  $('sign-pad').addEventListener('pointermove', (e) => {
    if (!pad.drawing) return;
    const p = padXY(e), prev = pad.drawing.pts[pad.drawing.pts.length - 1];
    p.v = Math.min(1.5, Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(1, p.t - prev.t));
    pad.drawing.pts.push(p);
    redrawPad();
  });
  $('sign-pad').addEventListener('pointerup', () => { pad.drawing = null; });
  document.querySelectorAll('#sign-colors button').forEach((b) => {
    b.onclick = () => {
      pad.color = b.dataset.c;
      document.querySelectorAll('#sign-colors button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  $('sign-clear').onclick = () => { pad.strokes = []; redrawPad(); };
  $('sign-cancel').onclick = () => { $('modal-sign').classList.add('hidden'); activeModal = null; setTool('filter'); };
  $('sign-use').onclick = async () => {
    if (!pad.strokes.length) return toast('Draw your signature first');
    // crop to the ink
    const c = $('sign-pad'), g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const m = 6, out = document.createElement('canvas');
    out.width = x1 - x0 + 2 * m; out.height = y1 - y0 + 2 * m;
    out.getContext('2d').drawImage(c, x0 - m, y0 - m, out.width, out.height, 0, 0, out.width, out.height);
    const png = out.toDataURL('image/png');
    await DB.setKV('signature', png);
    $('modal-sign').classList.add('hidden');
    activeModal = null;
    if (current() === 'v-page') placeSig(png);
  };

  // ---------- text (OCR) ----------
  let textCtx = null;
  async function ocrPage(page, onProgress) {
    const res = await OCR.recognize(page.out, onProgress);
    page.text = res.text; page.words = res.words; page.ocrW = page.outW;
    await DB.putPage(page);
    const i = state.pages.findIndex((p) => p.id === page.id);
    if (i >= 0) state.pages[i] = page;
    return res;
  }

  async function openText(page, force) {
    textCtx = page;
    sheet('sheet-text');
    const area = $('text-area');
    const prog = $('text-progress');
    $('text-title').textContent = page ? 'Text on page ' + (state.pages.findIndex((p) => p.id === page.id) + 1) : 'Text in "' + state.doc.name + '"';
    const pages = page ? [page] : state.pages;
    const todo = pages.filter((p) => force || !p.text);
    area.value = '';
    if (todo.length) {
      if (page && ed.dirty) await commitPage();
      prog.classList.remove('hidden');
      try {
        for (let i = 0; i < todo.length; i++) {
          const label = todo.length > 1 ? 'Reading page ' + (i + 1) + ' of ' + todo.length : 'Reading text';
          const set = (f) => {
            prog.querySelector('i').style.width = (((i + f) / todo.length) * 100) + '%';
            prog.querySelector('span').textContent = label + '… ' + Math.round(f * 100) + '%';
          };
          set(0);
          const target = page ? ed.page || page : todo[i];
          await ocrPage(target, set);
          if (page && ed.page) { ed.page.text = target.text; ed.page.words = target.words; }
        }
        await touchDoc(state.doc, state.pages);
      } catch (err) {
        toast('Text recognition failed: ' + err.message, 4000);
      }
      prog.classList.add('hidden');
    }
    const fresh = page ? [state.pages.find((p) => p.id === page.id) || page] : state.pages;
    area.value = fresh.length > 1
      ? fresh.map((p, i) => '— Page ' + (i + 1) + ' —\n' + (p.text || '')).join('\n\n')
      : (fresh[0].text || '');
    if (!area.value.trim()) area.placeholder = 'No text found on this page.';
  }
  $('text-copy').onclick = async () => { if (await Platform.copy($('text-area').value)) toast('Copied'); };
  $('text-share').onclick = () => Platform.shareText(state.doc.name, $('text-area').value);
  $('text-rerun').onclick = () => openText(textCtx, true);

  // ---------- export ----------
  let exportBusy = false;
  const exp = { size: 'a4', quality: 'high' };
  function seg(id, key) {
    document.querySelectorAll('#' + id + ' button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === exp[key]);
      b.onclick = () => { exp[key] = b.dataset.v; seg(id, key); };
    });
  }
  function openExport() {
    exp.size = state.settings.size || 'a4';
    $('exp-name').value = state.doc.name;
    seg('exp-size', 'size');
    seg('exp-quality', 'quality');
    $('exp-ocr').checked = state.pages.every((p) => p.words) && state.pages.some((p) => p.words && p.words.length);
    $('exp-progress').classList.add('hidden');
    sheet('sheet-export');
  }

  async function buildPdfBlob() {
    const q = { high: { max: 99999, q: 0 }, medium: { max: 1700, q: 0.75 }, small: { max: 1240, q: 0.6 } }[exp.quality];
    const withText = $('exp-ocr').checked;
    const prog = $('exp-progress');
    prog.classList.remove('hidden');
    const set = (f, label) => { prog.querySelector('i').style.width = (f * 100) + '%'; prog.querySelector('span').textContent = label; };
    const out = [];
    const n = state.pages.length;
    for (let i = 0; i < n; i++) {
      let page = state.pages[i];
      if (withText && !page.words) {
        await ocrPage(page, (f) => set((i + f) / n, 'Reading text on page ' + (i + 1) + ' of ' + n + '…'));
        page = state.pages[i];
      }
      set((i + 1) / n, 'Adding page ' + (i + 1) + ' of ' + n + '…');
      let blob = page.out, w = page.outW, h = page.outH;
      if (q.q && Math.max(w, h) > q.max) {
        const img = await Scan.decode(page.out);
        const c = Scan.toCanvas(img, q.max);
        blob = await Scan.toBlob(c, 'image/jpeg', q.q); w = c.width; h = c.height;
      } else if (q.q) {
        const img = await Scan.decode(page.out);
        const c = Scan.toCanvas(img);
        blob = await Scan.toBlob(c, 'image/jpeg', q.q);
      }
      const k = w / (page.ocrW || page.outW);
      const words = withText && page.words ? page.words.map((wd) => ({ text: wd.text, x0: wd.x0 * k, y0: wd.y0 * k, x1: wd.x1 * k, y1: wd.y1 * k })) : null;
      out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: w, height: h, words });
    }
    if (withText) await touchDoc(state.doc, state.pages);
    const bytes = PdfWriter.buildPdf(out, { pageSize: exp.size, title: $('exp-name').value || state.doc.name });
    return new Blob([bytes], { type: 'application/pdf' });
  }

  async function doExport(share) {
    if (exportBusy) return;
    exportBusy = true;
    $('exp-save').disabled = $('exp-share').disabled = true;
    try {
      const blob = await buildPdfBlob();
      const name = ($('exp-name').value.trim() || state.doc.name) + '.pdf';
      closeSheet();
      if (share) await Platform.shareFiles([{ blob, name }], name);
      else toast('Saved to ' + (await Platform.save(blob, name)) + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)', 4000);
    } catch (err) {
      toast('Export failed: ' + err.message, 4000);
    } finally {
      exportBusy = false;
      $('exp-save').disabled = $('exp-share').disabled = false;
      $('exp-progress').classList.add('hidden');
    }
  }
  $('exp-save').onclick = () => doExport(false);
  $('exp-share').onclick = () => doExport(true);

  // ---------- settings ----------
  $('btn-settings').onclick = async () => {
    $('set-filter').innerHTML = IP.FILTERS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
    $('set-filter').value = state.settings.filter;
    $('set-auto').checked = !!state.settings.auto;
    $('set-size').value = state.settings.size;
    $('set-prefix').value = state.settings.prefix;
    const est = await DB.estimate();
    $('about').textContent = 'Pagekeep Scan ' + VERSION + ' · ' + Platform.platform + '. Scans stay on this device' +
      (est && est.usage ? ' (' + (est.usage / 1048576).toFixed(0) + ' MB used)' : '') + '. Text recognition runs offline.';
    sheet('sheet-settings');
  };
  $('set-filter').onchange = (e) => { state.settings.filter = e.target.value; saveSettings(); };
  $('set-auto').onchange = (e) => { state.settings.auto = e.target.checked; saveSettings(); };
  $('set-size').onchange = (e) => { state.settings.size = e.target.value; saveSettings(); };
  $('set-prefix').onchange = (e) => { state.settings.prefix = e.target.value.trim() || 'Scan'; saveSettings(); };

  // ---------- back button (Android) & keyboard ----------
  async function goBack() {
    if (activeModal) return activeModal();
    if (openSheet) { if (!exportBusy) closeSheet(); return; }
    const v = current();
    if (v === 'v-camera') return closeCamera();
    if (v === 'v-crop') return $('crop-cancel').click();
    if (v === 'v-page') return $('page-back').click();
    if (v === 'v-doc') return $('doc-back').click();
    if (state.query) { $('search').value = ''; state.query = ''; return renderLibrary(); }
    Platform.exitApp();
  }
  Platform.onBack(goBack);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') goBack();
    if (current() === 'v-camera' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); capture(); }
    if (current() === 'v-page' && !e.target.closest('input,textarea')) {
      if (e.key === 'ArrowLeft' && ed.idx > 0) openPage(ed.idx - 1);
      if (e.key === 'ArrowRight' && ed.idx < state.pages.length - 1) openPage(ed.idx + 1);
    }
  });

  // ---------- start ----------
  (async function init() {
    try {
      const s = await DB.getKV('settings');
      if (s) Object.assign(state.settings, s);
    } catch (_) { /* first run */ }
    await loadLibrary();
    window.Pagekeep = { state, openDoc, importFiles, openPage, openCrop }; // for tests
  })();
})();
