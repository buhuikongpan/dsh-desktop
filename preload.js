// preload.js - Minimal preload script for DSH Desktop Shell
// The DSH WebUI runs in the webview with full access, just like in a browser.
// This preload exists as an extension point if you need to bridge
// native capabilities to the web page in the future.

const { contextBridge, ipcRenderer } = require('electron')

// Expose a minimal API to the web page
contextBridge.exposeInMainWorld('dshDesktop', {
  isDesktopShell: true,
  platform: process.platform,
  // Used by the built-in waiting/error status pages
  quit: () => ipcRenderer.send('dsh-desktop:quit'),
  retry: () => ipcRenderer.send('dsh-desktop:retry'),
})
