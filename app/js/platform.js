/* Platform layer: one API over Android (Capacitor plugins), Windows (Electron) and a plain browser. */
(function (root) {
  'use strict';
  const cap = root.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const P = (cap && cap.Plugins) || {};
  const isDesktop = !!root.pagekeepDesktop;
  const platform = isNative ? ((cap.getPlatform && cap.getPlatform()) || 'android') : isDesktop ? 'windows' : 'web';

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const safeName = (name) => String(name).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'scan';

  const Platform = {
    platform,
    native: isNative,
    desktop: isDesktop,

    tap() {
      try {
        if (isNative && P.Haptics) P.Haptics.impact({ style: 'LIGHT' });
        else if (navigator.vibrate) navigator.vibrate(10);
      } catch (_) { /* ignore */ }
    },

    async copy(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    },

    // Save a file where the person can find it. Returns a short description of where it went.
    async save(blob, name) {
      name = safeName(name);
      if (isNative && P.Filesystem) {
        const data = await blobToBase64(blob);
        await P.Filesystem.writeFile({ path: 'Pagekeep/' + name, data, directory: 'DOCUMENTS', recursive: true });
        return 'Documents/Pagekeep/' + name;
      }
      download(blob, name);
      return isDesktop ? name : 'your downloads';
    },

    // Share one or more files with other apps. files: [{ blob, name }]
    async shareFiles(files, title) {
      if (isNative && P.Filesystem && P.Share) {
        const uris = [];
        for (const f of files) {
          const data = await blobToBase64(f.blob);
          const r = await P.Filesystem.writeFile({ path: 'share/' + safeName(f.name), data, directory: 'CACHE', recursive: true });
          uris.push(r.uri);
        }
        try { await P.Share.share({ title, files: uris, dialogTitle: title }); return 'shared'; } catch (_) { return 'cancelled'; }
      }
      const fileObjs = files.map((f) => new File([f.blob], safeName(f.name), { type: f.blob.type }));
      if (navigator.canShare && navigator.canShare({ files: fileObjs })) {
        try { await navigator.share({ title, files: fileObjs }); return 'shared'; } catch (_) { return 'cancelled'; }
      }
      for (const f of files) download(f.blob, safeName(f.name));
      return 'saved';
    },

    async shareText(title, text) {
      if (isNative && P.Share) {
        try { await P.Share.share({ title, text, dialogTitle: title }); return 'shared'; } catch (_) { return 'cancelled'; }
      }
      if (navigator.share) {
        try { await navigator.share({ title, text }); return 'shared'; } catch (_) { return 'cancelled'; }
      }
      return (await Platform.copy(text)) ? 'copied' : 'failed';
    },

    onBack(fn) {
      if (isNative && P.App) P.App.addListener('backButton', fn);
    },
    exitApp() {
      if (isNative && P.App) P.App.exitApp();
    },
    keepAwake(on) {
      // camera preview: keep the screen on where the Wake Lock API exists
      try {
        if (on && navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { Platform._lock = l; }).catch(() => {});
        else if (!on && Platform._lock) { Platform._lock.release(); Platform._lock = null; }
      } catch (_) { /* ignore */ }
    },
  };

  root.Platform = Platform;
})(typeof self !== 'undefined' ? self : this);
