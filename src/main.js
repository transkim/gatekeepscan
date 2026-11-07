const { app, BrowserWindow, shell, protocol, net, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_DIR = path.join(__dirname, '..', 'app');

// Serve the UI from app://pagekeep/ so workers, fetch and WebAssembly (text recognition) work like on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});
app.setAppUserModelId('app.pagekeep.desktop');

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'Pagekeep',
    icon: path.join(APP_DIR, 'img', 'icon.png'),
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://pagekeep/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // the webcam is the only permission the app asks for
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
