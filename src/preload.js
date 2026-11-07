const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('pagekeepDesktop', { platform: process.platform });
