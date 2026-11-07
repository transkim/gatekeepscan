/* Pagekeep storage: IndexedDB with documents, pages (image blobs) and settings. Everything stays on the device. */
(function (root) {
  'use strict';
  const NAME = 'pagekeep', VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) {
          const s = db.createObjectStore('pages', { keyPath: 'id' });
          s.createIndex('docId', 'docId');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(stores, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    }));
  }

  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const DB = {
    uid,
    async listDocs() {
      const docs = await tx(['docs'], 'readonly', (t) => req2p(t.objectStore('docs').getAll()));
      return docs.sort((a, b) => b.updated - a.updated);
    },
    getDoc: (id) => tx(['docs'], 'readonly', (t) => req2p(t.objectStore('docs').get(id))),
    putDoc: (doc) => tx(['docs'], 'readwrite', (t) => { t.objectStore('docs').put(doc); }),
    getPage: (id) => tx(['pages'], 'readonly', (t) => req2p(t.objectStore('pages').get(id))),
    putPage: (page) => tx(['pages'], 'readwrite', (t) => { t.objectStore('pages').put(page); }),
    async getPages(doc) {
      const pages = await tx(['pages'], 'readonly', (t) => Promise.all(doc.pages.map((id) => req2p(t.objectStore('pages').get(id)))));
      return pages.filter(Boolean);
    },
    deletePage: (id) => tx(['pages'], 'readwrite', (t) => { t.objectStore('pages').delete(id); }),
    async deleteDoc(doc) {
      await tx(['docs', 'pages'], 'readwrite', (t) => {
        doc.pages.forEach((id) => t.objectStore('pages').delete(id));
        t.objectStore('docs').delete(doc.id);
      });
    },
    getKV: (k) => tx(['kv'], 'readonly', (t) => req2p(t.objectStore('kv').get(k))),
    setKV: (k, v) => tx(['kv'], 'readwrite', (t) => { t.objectStore('kv').put(v, k); }),
    async estimate() {
      try { return await navigator.storage.estimate(); } catch (_) { return null; }
    },
  };

  root.DB = DB;
})(typeof self !== 'undefined' ? self : this);
